import '@fontsource/antonio/latin-600.css';
import '@fontsource/ibm-plex-mono/latin-400.css';
import '@fontsource/ibm-plex-mono/latin-500.css';
import '@fontsource/space-grotesk/latin-400.css';
import '@fontsource/space-grotesk/latin-500.css';
import './styles.css';

import { initializeClarity } from './analytics/clarity';
import { CalibrationStore, DEFAULT_CALIBRATION } from './core/calibration';
import { GestureEngine } from './core/gestureEngine';
import type {
  CalibrationBounds,
  GestureMode,
  GestureSnapshot,
  HandObservation,
  TrackingStats,
} from './core/types';
import { SolarCoreScene } from './scene/solarCore';
import { CameraTracker } from './tracking/cameraTracker';
import { CalibrationSession, type CalibrationProgress } from './ui/calibrationSession';
import { drawCameraPreview } from './ui/skeleton';
import { appTemplate } from './ui/template';
import { InputArbiter } from './voice/control/authority';
import { OrionVoice } from './voice/orionVoiceController';
import type { ClientState, ControlAuthority, OrbCommand } from './voice/types';

const MODE_COPY: Record<GestureMode, { word: string; index: string; hint: string }> = {
  ready: { word: 'READY', index: '00', hint: 'Raise one hand inside the camera frame.' },
  awake: { word: 'AWAKE', index: '01', hint: 'Aim at the core. Bring thumb and index finger together.' },
  grab: { word: 'GRAB', index: '02', hint: 'Keep pinching and move your hand to rotate the core.' },
  dual: { word: 'DUAL CONTROL', index: '03', hint: 'Spread to dive through the core. Release, re-pinch, and repeat to keep travelling.' },
  release: { word: 'RELEASE', index: '04', hint: 'Open both hands before beginning another grab.' },
  charge: { word: 'CHARGE', index: '05', hint: 'Hold the fist steady. Open it rapidly to disperse the stored energy.' },
  burst: { word: 'DISPERSE', index: '06', hint: 'Energy released. Let the structure settle before the next gesture.' },
  'unfold-armed': { word: 'VECTOR LOCK', index: '07', hint: 'The field is armed. Sweep both open palms outward.' },
  unfold: { word: 'UNFOLD', index: '08', hint: 'The core lattice is expanding into the surrounding field.' },
  expanded: { word: 'FIELD OPEN', index: '09', hint: 'Pinch with both hands to rotate and zoom the field. Hold two fists to collapse it.' },
  collapse: { word: 'COLLAPSE', index: '10', hint: 'The surrounding lattice is returning to its source.' },
};

const CAPABILITY_PROMPTS = [
  {
    prompt: 'Compare Arnav’s work to the latest agent trends, then open his GitHub.',
    chain: 'EVIDENCE → LIVE SEARCH → NEW TAB',
  },
  {
    prompt: 'What changed in AI today? Give me the sharp version.',
    chain: 'LIVE SEARCH → SOURCES',
  },
  {
    prompt: 'Open the field, zoom through it, then spin slowly.',
    chain: '3 CORE ACTIONS',
  },
  {
    prompt: 'Use JavaScript to make this interface react to my next word.',
    chain: 'IN-TAB JAVASCRIPT',
  },
  {
    prompt: 'Why should an AI infrastructure team interview Arnav?',
    chain: 'CAREER EVIDENCE → JUDGMENT',
  },
] as const;

class SolarCoreApp {
  private readonly canvas: HTMLCanvasElement;
  private readonly video: HTMLVideoElement;
  private readonly scene: SolarCoreScene;
  private readonly store = new CalibrationStore(window.localStorage);
  private readonly tracker: CameraTracker;
  private readonly arbiter = new InputArbiter();
  private readonly voice: OrionVoice;
  private readonly reticleElements = new Map<string, HTMLElement>();
  private calibration: CalibrationBounds;
  private gestureEngine: GestureEngine;
  private calibrationSession?: CalibrationSession;
  private currentCameraId?: string;
  private latestHands: HandObservation[] = [];
  private cameraStarted = false;
  private calibrating = false;
  private debugOpen = false;
  private previewFrame = 0;
  private readonly demoMode: GestureMode | null;
  private readonly frozen: boolean;
  private readonly ownerMode: boolean;
  private authority: ControlAuthority = 'ambient';
  private authorityTimer = 0;
  private hasExperiencedGesture = false;
  private capabilityIndex = 0;
  private capabilityTimer = 0;
  private capabilityPaused = false;

  constructor(root: HTMLElement) {
    root.innerHTML = appTemplate();
    this.canvas = mustElement<HTMLCanvasElement>('solar-scene');
    this.video = mustElement<HTMLVideoElement>('camera-source');

    const params = new URLSearchParams(window.location.search);
    this.demoMode = parseDemoMode(params.get('demo'));
    this.frozen = params.get('freeze') === '1';
    this.ownerMode = params.get('owner') === '1';
    mustElement<HTMLElement>('owner-access').hidden = !this.ownerMode;
    if (this.ownerMode) {
      mustElement<HTMLElement>('model-status').textContent = 'Paste the owner access code before entering Orion.';
    }
    window.localStorage.removeItem('solar-core.visual-tuning.v1');
    this.calibration = this.store.load() ?? DEFAULT_CALIBRATION;
    this.gestureEngine = new GestureEngine(this.calibration, () => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));

    try {
      this.scene = new SolarCoreScene(
        this.canvas,
        (fps) => this.updateRenderFps(fps),
        this.frozen,
      );
    } catch (error) {
      throw new Error(
        error instanceof Error
          ? `WebGL could not start: ${error.message}`
          : 'WebGL could not start in this browser.',
      );
    }

    this.tracker = new CameraTracker({
      onHands: (hands, timestamp) => this.handleHands(hands, timestamp),
      onStats: (stats) => this.handleStats(stats),
      onError: (message) => this.showCapabilityNotice('CAMERA DISCONNECTED', `${message} Voice control remains available.`),
    });
    this.voice = new OrionVoice({
      onCommand: (command, label) => this.applyVoiceCommand(command, label),
      getClientState: () => ({
        authority: this.authority,
        orb: this.scene.getRuntimeState(),
      } satisfies Pick<ClientState, 'authority' | 'orb'>),
      onVoiceActivity: () => undefined,
      onOutputLevel: (level) => {
        this.scene.setVoiceOutputLevel(level);
        const rootStyle = document.documentElement.style;
        rootStyle.setProperty('--voice-level', level.toFixed(3));
        rootStyle.setProperty('--voice-filament-scale', (0.34 + level * 0.66).toFixed(3));
        rootStyle.setProperty('--voice-filament-opacity', (0.42 + level * 0.55).toFixed(3));
        rootStyle.setProperty('--voice-glow', `${(8 + level * 20).toFixed(1)}px`);
        rootStyle.setProperty('--voice-aura', `${(24 + level * 30).toFixed(1)}px`);
        rootStyle.setProperty('--voice-wash', (0.04 + level * 0.08).toFixed(3));
      },
    });

    this.bindControls();
    this.initializeCapabilityDiscovery(params.get('discover') === '1');
    this.previewFrame = requestAnimationFrame(this.drawPreviews);
    window.addEventListener('beforeunload', () => this.destroy(), { once: true });

    if (this.demoMode) {
      this.startDemo(this.demoMode, parseDemoZoom(params.get('zoom')));
      if (params.get('voice') === 'mock') void this.voice.initialize();
    }
    else this.applySnapshot(this.gestureEngine.update([], performance.now()));
  }

  private bindControls(): void {
    mustElement<HTMLButtonElement>('enter-orion').addEventListener('click', () => {
      void this.startExperience();
    });
    mustElement<HTMLButtonElement>('default-calibration').addEventListener('click', () => {
      this.finishCalibration({ ...DEFAULT_CALIBRATION, ...(this.currentCameraId ? { cameraId: this.currentCameraId } : {}) });
    });
    mustElement<HTMLButtonElement>('retry-button').addEventListener('click', () => window.location.reload());
    document.querySelectorAll<HTMLElement>('[data-action="debug"]').forEach((button) => {
      button.addEventListener('click', () => this.toggleDebug());
    });
    document.querySelectorAll<HTMLElement>('[data-action="fullscreen"]').forEach((button) => {
      button.addEventListener('click', () => void this.toggleFullscreen());
    });
    document.querySelectorAll<HTMLElement>('[data-action="guide"]').forEach((button) => {
      button.addEventListener('click', () => this.toggleGuide());
    });
    document.querySelectorAll<HTMLButtonElement>('[data-suggest]').forEach((button) => {
      button.addEventListener('click', () => {
        const prompt = button.dataset.suggest;
        if (!prompt) return;
        this.toggleGuide(false);
        this.voice.runSuggestedPrompt(prompt);
      });
    });
    mustElement<HTMLSelectElement>('camera-select').addEventListener('change', (event) => {
      const select = event.currentTarget as HTMLSelectElement;
      void this.changeCamera(select.value);
    });
    window.addEventListener('keydown', (event) => {
      if (event.repeat || isFormControl(event.target)) return;
      if (event.key.toLowerCase() === 'd') this.toggleDebug();
      if (event.key.toLowerCase() === 'f') void this.toggleFullscreen();
      if (event.key.toLowerCase() === 'c' && this.cameraStarted) this.startCalibration();
      if (event.key.toLowerCase() === 'i') this.toggleGuide();
      if (event.key === 'Escape' && document.body.classList.contains('guide-open')) this.toggleGuide(false);
    });
  }

  private initializeCapabilityDiscovery(forcePreview: boolean): void {
    const runway = mustElement<HTMLElement>('capability-runway');
    if (forcePreview) document.body.classList.add('discovery-preview');

    const dots = mustElement<HTMLElement>('capability-dots');
    CAPABILITY_PROMPTS.forEach((_, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('aria-label', `Show suggested prompt ${index + 1}`);
      button.addEventListener('click', () => this.renderCapabilityPrompt(index));
      dots.append(button);
    });
    this.renderCapabilityPrompt(0, false);

    mustElement<HTMLButtonElement>('capability-prompt').addEventListener('click', () => {
      this.voice.runSuggestedPrompt(CAPABILITY_PROMPTS[this.capabilityIndex]!.prompt);
    });
    mustElement<HTMLButtonElement>('dismiss-capabilities').addEventListener('click', () => {
      this.retireCapabilityDiscovery();
    });
    runway.addEventListener('pointerenter', () => { this.capabilityPaused = true; });
    runway.addEventListener('pointerleave', () => { this.capabilityPaused = false; });
    runway.addEventListener('focusin', () => { this.capabilityPaused = true; });
    runway.addEventListener('focusout', () => { this.capabilityPaused = false; });
    this.capabilityTimer = window.setInterval(() => {
      if (!this.capabilityPaused && !document.body.classList.contains('capability-explored')) {
        this.renderCapabilityPrompt((this.capabilityIndex + 1) % CAPABILITY_PROMPTS.length);
      }
    }, 5_200);
  }

  private renderCapabilityPrompt(index: number, animate = true): void {
    this.capabilityIndex = index;
    const runway = mustElement<HTMLElement>('capability-runway');
    const update = (): void => {
      const item = CAPABILITY_PROMPTS[index]!;
      mustElement<HTMLElement>('capability-prompt-copy').textContent = item.prompt;
      mustElement<HTMLElement>('capability-chain-copy').textContent = item.chain;
      mustElement<HTMLElement>('capability-count').textContent = `${String(index + 1).padStart(2, '0')} / ${String(CAPABILITY_PROMPTS.length).padStart(2, '0')}`;
      [...mustElement<HTMLElement>('capability-dots').children].forEach((dot, dotIndex) => {
        if (dot instanceof HTMLElement) dot.dataset.active = String(dotIndex === index);
      });
      runway.classList.remove('is-changing');
    };
    if (!animate || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      update();
      return;
    }
    runway.classList.add('is-changing');
    window.setTimeout(update, 130);
  }

  private retireCapabilityDiscovery(): void {
    document.body.classList.add('capability-explored');
    window.clearInterval(this.capabilityTimer);
  }

  private toggleGuide(force?: boolean): void {
    const panel = mustElement<HTMLElement>('guide-panel');
    const open = force ?? !document.body.classList.contains('guide-open');
    document.body.classList.toggle('guide-open', open);
    panel.setAttribute('aria-hidden', String(!open));
    panel.inert = !open;
    document.querySelector<HTMLElement>('.info-button')?.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector<HTMLButtonElement>('.guide-close')?.focus();
  }

  private async startExperience(): Promise<void> {
    const button = mustElement<HTMLButtonElement>('enter-orion');
    const status = mustElement<HTMLElement>('model-status');
    const ownerInput = mustElement<HTMLInputElement>('owner-access-code');
    if (this.ownerMode && !ownerInput.value.trim()) {
      status.textContent = 'Owner access code is required for the session override.';
      ownerInput.focus();
      return;
    }
    button.disabled = true;
    button.querySelector('span')!.textContent = 'Entering…';
    status.textContent = 'Starting local vision and a private voice session.';
    document.body.dataset.setup = 'loading';

    const [camera, voice] = await Promise.allSettled([
      this.startCameraCapability(),
      this.voice.initialize(),
    ]);

    if (camera.status === 'fulfilled') {
      if (this.store.load()) this.enterControl();
      else this.startCalibration();
    } else {
      this.enterControl();
      const detail = camera.reason instanceof Error ? camera.reason.message : 'Chrome could not start the camera.';
      this.showCapabilityNotice(cameraErrorTitle(camera.reason), `${detail} Voice and the ambient scene remain available.`);
    }
    if (voice.status === 'rejected') {
      this.showCapabilityNotice('VOICE SESSION UNAVAILABLE', 'Hand control remains available. Check microphone access and retry voice.');
    }
    button.disabled = false;
    button.querySelector('span')!.textContent = 'Enter Orion';
  }

  private async startCameraCapability(): Promise<void> {
    try {
      this.currentCameraId = await this.tracker.start(this.video, this.calibration.cameraId);
      this.cameraStarted = true;
      await this.populateCameras();
    } catch (error) {
      throw error;
    }
  }

  private handleHands(hands: HandObservation[], timestamp: number): void {
    this.latestHands = hands;
    mustElement<HTMLElement>('hand-count').textContent = `HANDS ${hands.length}`;
    mustElement<HTMLElement>('debug-hands').textContent = String(hands.length);

    if (this.calibrating && this.calibrationSession) {
      const progress = this.calibrationSession.update(hands);
      this.updateCalibrationUi(progress);
      if (progress.completed) {
        try {
          this.finishCalibration(this.calibrationSession.getBounds());
        } catch (error) {
          this.showError(
            'Calibration range too small',
            error instanceof Error ? error.message : 'Move farther between markers and retry.',
          );
        }
      }
      return;
    }

    if (this.cameraStarted) this.applySnapshot(this.gestureEngine.update(hands, timestamp));
  }

  private startCalibration(): void {
    if (!this.cameraStarted) return;
    this.calibrating = true;
    this.calibrationSession = new CalibrationSession(this.currentCameraId);
    mustElement<HTMLElement>('setup-overlay').hidden = false;
    mustElement<HTMLElement>('start-panel').hidden = true;
    mustElement<HTMLElement>('calibration-panel').hidden = false;
    document.body.dataset.setup = 'calibration';
    this.updateCalibrationUi({
      currentIndex: 0,
      target: { x: 0.18, y: 0.2, label: 'upper-left' },
      reticle: null,
      completed: false,
    });
  }

  private updateCalibrationUi(progress: CalibrationProgress): void {
    const target = progress.target;
    const targetElement = mustElement<HTMLElement>('calibration-target');
    const reticle = mustElement<HTMLElement>('calibration-reticle');
    mustElement<HTMLElement>('calibration-count').textContent = `${Math.min(progress.currentIndex + 1, 4)} OF 4`;
    mustElement<HTMLElement>('target-name').textContent = target?.label ?? 'final';
    targetElement.hidden = !target;
    if (target) {
      targetElement.style.setProperty('--target-x', `${target.x * 100}%`);
      targetElement.style.setProperty('--target-y', `${target.y * 100}%`);
    }
    reticle.hidden = !progress.reticle;
    if (progress.reticle) {
      reticle.style.setProperty('--reticle-x', `${progress.reticle.x * 100}%`);
      reticle.style.setProperty('--reticle-y', `${progress.reticle.y * 100}%`);
      reticle.classList.toggle('is-pinched', progress.reticle.pinched);
    }
  }

  private finishCalibration(bounds: CalibrationBounds): void {
    this.calibration = bounds;
    this.store.save(bounds);
    this.gestureEngine.setCalibration(bounds);
    this.calibrating = false;
    this.calibrationSession = undefined;
    this.enterControl();
  }

  private enterControl(): void {
    mustElement<HTMLElement>('setup-overlay').hidden = true;
    mustElement<HTMLElement>('start-panel').hidden = false;
    mustElement<HTMLElement>('calibration-panel').hidden = true;
    document.body.dataset.setup = 'active';
    document.body.classList.add('control-active');
    this.applySnapshot(this.gestureEngine.update(this.latestHands, performance.now()));
  }

  private applySnapshot(snapshot: GestureSnapshot): void {
    const nextAuthority = this.arbiter.updateHands(snapshot);
    if (nextAuthority === 'hand' && this.authority !== 'hand') {
      window.clearTimeout(this.authorityTimer);
      this.scene.cancelVoiceMotion();
    }
    this.authority = nextAuthority;
    this.renderAuthority();
    this.scene.setGesture(snapshot);
    const copy = MODE_COPY[snapshot.mode];
    const word = mustElement<HTMLElement>('status-word');
    document.body.dataset.state = snapshot.mode;
    if (!this.hasExperiencedGesture && ['grab', 'dual', 'charge', 'burst', 'unfold', 'expanded'].includes(snapshot.mode)) {
      this.hasExperiencedGesture = true;
      document.body.classList.add('gesture-learned');
    }
    word.textContent = copy.word;
    word.dataset.text = copy.word;
    word.setAttribute('aria-label', copy.word);
    mustElement<HTMLElement>('state-index').textContent = copy.index;
    mustElement<HTMLElement>('gesture-hint').textContent = copy.hint;
    mustElement<HTMLElement>('quality-label').textContent = snapshot.trackingQuality
      ? `TRACKING ${Math.round(snapshot.trackingQuality * 100)}%`
      : 'TRACKING —';
    this.updateReticles(snapshot);
  }

  private updateReticles(snapshot: GestureSnapshot): void {
    const layer = mustElement<HTMLElement>('reticle-layer');
    const activeIds = new Set(snapshot.reticles.map((reticle) => reticle.handId));
    for (const [id, element] of this.reticleElements) {
      if (!activeIds.has(id)) {
        element.remove();
        this.reticleElements.delete(id);
      }
    }

    snapshot.reticles.forEach((reticle) => {
      let element = this.reticleElements.get(reticle.handId);
      if (!element) {
        element = document.createElement('div');
        element.className = 'hand-reticle';
        element.innerHTML = '<i></i><b></b><span></span>';
        layer.append(element);
        this.reticleElements.set(reticle.handId, element);
      }
      element.dataset.hand = reticle.handedness.toLowerCase();
      element.dataset.pose = reticle.pose;
      element.classList.toggle('is-pinched', reticle.pinched);
      element.style.setProperty('--x', `${reticle.x * 100}%`);
      element.style.setProperty('--y', `${reticle.y * 100}%`);
      element.style.setProperty('--pinch', String(reticle.pinchStrength));
      element.style.opacity = String(reticle.visibility);
    });
  }

  private handleStats(stats: TrackingStats): void {
    mustElement<HTMLElement>('debug-tracking-fps').textContent = `${stats.trackingFps} fps`;
    mustElement<HTMLElement>('debug-inference').textContent = `${stats.inferenceMs.toFixed(1)} ms`;
    mustElement<HTMLElement>('debug-delegate').textContent = stats.delegate;
    mustElement<HTMLElement>('debug-dropped').textContent = String(stats.droppedFrames);
  }

  private updateRenderFps(fps: number): void {
    const displayFps = this.demoMode && this.frozen ? 60 : fps;
    mustElement<HTMLElement>('fps-label').textContent = `RENDER ${displayFps} FPS`;
    mustElement<HTMLElement>('debug-render-fps').textContent = `${displayFps} fps`;
  }

  private async populateCameras(): Promise<void> {
    const cameras = await this.tracker.listCameras();
    const select = mustElement<HTMLSelectElement>('camera-select');
    select.replaceChildren();
    cameras.forEach((camera, index) => {
      const option = document.createElement('option');
      option.value = camera.deviceId;
      option.textContent = camera.label || `Camera ${index + 1}`;
      option.selected = camera.deviceId === this.currentCameraId;
      select.append(option);
    });
  }

  private async changeCamera(deviceId: string): Promise<void> {
    try {
      this.currentCameraId = await this.tracker.switchCamera(deviceId);
      await this.populateCameras();
      this.startCalibration();
    } catch (error) {
      this.showError(
        'Camera change failed',
        error instanceof Error ? error.message : 'The selected camera could not start.',
      );
    }
  }

  private toggleDebug(): void {
    this.debugOpen = !this.debugOpen;
    document.body.classList.toggle('debug-open', this.debugOpen);
    const panel = mustElement<HTMLElement>('debug-panel');
    panel.setAttribute('aria-hidden', String(!this.debugOpen));
    panel.inert = !this.debugOpen;
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      this.showError('Fullscreen unavailable', 'Chrome blocked fullscreen. Click the fullscreen control and retry.');
    }
  }

  private showError(title: string, message: string): void {
    const panel = mustElement<HTMLElement>('error-panel');
    mustElement<HTMLElement>('error-title').textContent = title;
    mustElement<HTMLElement>('error-message').textContent = message;
    panel.hidden = false;
  }

  private showCapabilityNotice(title: string, message: string): void {
    this.voice.notify(`${title.toUpperCase()} · ${message}`);
  }

  private applyVoiceCommand(command: OrbCommand, _label: string): boolean {
    if (!this.arbiter.requestVoice()) return false;
    this.authority = 'voice';
    this.renderAuthority();
    if (command.kind === 'field') this.gestureEngine.setFieldState(command.state === 'open');
    if (command.kind === 'reset') this.gestureEngine.setFieldState(false);
    this.scene.applyVoiceCommand(command);
    window.clearTimeout(this.authorityTimer);
    if (command.kind !== 'spin') {
      this.authorityTimer = window.setTimeout(() => {
        this.arbiter.settleVoice();
        this.authority = this.arbiter.current;
        this.renderAuthority();
      }, command.kind === 'rotate' ? command.durationMs + 400 : 1_200);
    }
    return true;
  }

  private renderAuthority(): void {
    const status = mustElement<HTMLElement>('authority-status');
    status.textContent = `${this.authority.toUpperCase()} CONTROL`;
    status.dataset.tone = this.authority;
    document.body.dataset.authority = this.authority;
  }

  private drawPreviews = (): void => {
    if (this.calibrating) {
      drawCameraPreview(
        mustElement<HTMLCanvasElement>('calibration-preview'),
        this.video,
        this.latestHands,
        true,
      );
    }
    if (this.debugOpen) {
      drawCameraPreview(
        mustElement<HTMLCanvasElement>('debug-preview'),
        this.video,
        this.latestHands,
        true,
      );
    }
    this.previewFrame = requestAnimationFrame(this.drawPreviews);
  };

  private startDemo(mode: GestureMode, zoomRatio = 1.24): void {
    mustElement<HTMLElement>('setup-overlay').hidden = true;
    document.body.dataset.setup = 'active';
    document.body.classList.add('control-active', 'demo-mode');
    mustElement<HTMLElement>('input-label').textContent = 'DEMO INPUT';
    this.updateRenderFps(60);
    const snapshot = demoSnapshot(mode, zoomRatio);
    mustElement<HTMLElement>('hand-count').textContent = `HANDS ${snapshot.reticles.length}`;
    this.applySnapshot(snapshot);
  }

  private destroy(): void {
    cancelAnimationFrame(this.previewFrame);
    window.clearTimeout(this.authorityTimer);
    window.clearInterval(this.capabilityTimer);
    this.tracker.stop();
    void this.voice.destroy();
    this.scene.dispose();
  }
}

function demoSnapshot(mode: GestureMode, zoomRatio = 1.24): GestureSnapshot {
  const twoHandMode = ['dual', 'unfold-armed', 'unfold', 'expanded', 'collapse'].includes(mode);
  const openPalmMode = ['burst', 'unfold-armed', 'unfold', 'expanded'].includes(mode);
  const fistMode = mode === 'charge' || mode === 'collapse';
  const unfoldedPosition = ['unfold', 'expanded'].includes(mode);
  const left = {
    handId: 'demo-left',
    handedness: 'Left' as const,
    x: mode === 'dual' || unfoldedPosition ? 0.22 : mode === 'unfold-armed' ? 0.39 : 0.34,
    y: 0.46,
    pinched: mode === 'grab' || mode === 'dual',
    pinchStrength: mode === 'grab' || mode === 'dual' ? 0.96 : 0.12,
    pose: fistMode ? 'fist' as const : openPalmMode ? 'open' as const : 'neutral' as const,
    palmX: mode === 'unfold-armed' ? 0.39 : unfoldedPosition ? 0.22 : 0.34,
    palmY: 0.52,
    visibility: 1,
  };
  const right = {
    handId: 'demo-right',
    handedness: 'Right' as const,
    x: mode === 'unfold-armed' ? 0.61 : 0.8,
    y: 0.43,
    pinched: mode === 'dual',
    pinchStrength: mode === 'dual' ? 0.94 : 0.1,
    pose: fistMode ? 'fist' as const : openPalmMode ? 'open' as const : 'neutral' as const,
    palmX: mode === 'unfold-armed' ? 0.61 : 0.8,
    palmY: 0.5,
    visibility: 1,
  };
  return {
    timestamp: performance.now(),
    mode,
    reticles: mode === 'ready' ? [] : twoHandMode ? [left, right] : [left],
    rotationDelta: mode === 'grab' ? { x: -0.08, y: 0.16 } : { x: 0, y: 0 },
    scaleRatio: mode === 'dual' ? zoomRatio : 1,
    rollDelta: mode === 'dual' ? -0.22 : 0,
    fieldControl: false,
    chargeLevel: mode === 'charge' ? 0.88 : 0,
    intensity: ['dual', 'unfold'].includes(mode)
      ? 1
      : mode === 'burst'
        ? 0.72
      : mode === 'grab'
        ? 0.76
        : mode === 'charge'
          ? 0.55
          : mode === 'expanded'
            ? 0.42
            : mode === 'awake'
              ? 0.26
              : 0,
    trackingQuality: mode === 'ready' ? 0 : 0.98,
  };
}

function parseDemoMode(value: string | null): GestureMode | null {
  return value && [
    'ready',
    'awake',
    'grab',
    'dual',
    'release',
    'charge',
    'burst',
    'unfold-armed',
    'unfold',
    'expanded',
    'collapse',
  ].includes(value)
    ? (value as GestureMode)
    : null;
}

function parseDemoZoom(value: string | null): number {
  const zoom = Number(value);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1.24;
}

function cameraErrorTitle(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Camera permission blocked';
    if (error.name === 'NotFoundError') return 'No camera found';
    if (error.name === 'NotReadableError') return 'Camera already in use';
  }
  return 'Camera could not start';
}

function mustElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing interface element: ${id}`);
  return element as T;
}

function isFormControl(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;
}

const root = document.getElementById('app');
if (!root) throw new Error('The application root is missing.');

initializeClarity();

try {
  new SolarCoreApp(root);
} catch (error) {
  root.innerHTML = `
    <section class="fatal-error">
      <p>CONTROL INTERRUPTED</p>
      <h1>Orion could not start.</h1>
      <pre>${escapeHtml(error instanceof Error ? error.message : String(error))}</pre>
    </section>
  `;
}

function escapeHtml(value: string): string {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}
