import '@fontsource/antonio/400.css';
import '@fontsource/antonio/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import '@fontsource/space-grotesk/400.css';
import '@fontsource/space-grotesk/500.css';
import './styles.css';
import { apiError } from '../voice/api/providerErrors';
import { MicStateMachine } from '../voice/control/micStateMachine';
import { MicrophoneCapture } from '../voice/input/microphoneCapture';
import { buildGeminiTranscriptionPrompt } from '../voice/input/transcriptionVocabulary';
import { createBrowserSession } from '../voice/session/browserSession';
import type { MicState } from '../voice/types';
import { GeminiLiveTranscriptionClient } from './geminiLiveClient';
import {
  GEMINI_LIVE_MODELS,
  type GeminiBatchModel,
  type GeminiLiveModel,
} from './geminiModels';
import {
  estimateGeminiBatchCost,
  estimateGeminiLiveCost,
  percentile,
  type GeminiTranscriptionUsage,
} from './pricing';
import { pcm16ChunksToWav, pcmDurationMs } from './wav';

type ComparisonSlot = 'g31-live' | 'g25-live' | 'g3-flash' | 'g31-lite';

const SLOT_MODELS = {
  'g31-live': 'gemini-3.1-flash-live-preview',
  'g25-live': 'gemini-2.5-flash-native-audio-preview-12-2025',
  'g3-flash': 'gemini-3-flash-preview',
  'g31-lite': 'gemini-3.1-flash-lite',
} as const satisfies Record<ComparisonSlot, GeminiLiveModel | GeminiBatchModel>;

const ALL_SLOTS = Object.keys(SLOT_MODELS) as ComparisonSlot[];
const LIVE_SLOTS = ['g31-live', 'g25-live'] as const satisfies readonly ComparisonSlot[];
const BATCH_SLOTS = ['g3-flash', 'g31-lite'] as const satisfies readonly ComparisonSlot[];

interface GeminiLiveTokenResponse {
  tokens?: Partial<Record<GeminiLiveModel, string>>;
}

interface GeminiTranscriptResponse {
  transcript?: string;
  usage?: GeminiTranscriptionUsage;
}

class SttComparisonController {
  private readonly audio = new MicrophoneCapture();
  private readonly micState: MicStateMachine;
  private readonly waveformBars = [...document.querySelectorAll<HTMLElement>('#comparison-waveform i')];
  private readonly liveClients = new Map<ComparisonSlot, GeminiLiveTranscriptionClient>();
  private readonly connectedLive = new Set<ComparisonSlot>();
  private readonly latencyHistory = new Map<ComparisonSlot, number[]>(ALL_SLOTS.map((slot) => [slot, []]));
  private connectionTask?: Promise<void>;
  private chunks: ArrayBuffer[] = [];
  private initialized = false;
  private captureStartedAt = 0;
  private releasedAt = 0;
  private maxRecordingTimer = 0;
  private turnGeneration = 0;
  private requestAbort?: AbortController;
  private ownerAccessCode = '';

  constructor() {
    this.micState = new MicStateMachine({
      onStart: () => { void this.startListening(); },
      onFinalize: () => { void this.finishListening(); },
      onCancelResponse: () => this.cancelActiveComparison(),
      onState: (state) => this.renderMicState(state),
    });
    this.bindControls();
    requestAnimationFrame(this.drawWaveform);
  }

  async initialize(): Promise<void> {
    const button = element<HTMLButtonElement>('initialize-comparison');
    const error = element<HTMLElement>('gate-error');
    button.disabled = true;
    button.textContent = 'CONNECTING…';
    error.hidden = true;
    try {
      await Promise.all([this.establishSession(), this.audio.initialize()]);
      this.initialized = true;
      element<HTMLElement>('entry-gate').hidden = true;
      element<HTMLElement>('comparison-workspace').hidden = false;
      element<HTMLElement>('session-state').textContent = 'LINKED';
      document.body.classList.add('comparison-ready');
      this.setNote('Hold Space to run one identical capture through all four Gemini paths.');
    } catch (cause) {
      error.textContent = cause instanceof Error ? cause.message : 'The comparison could not start.';
      error.hidden = false;
      button.disabled = false;
      button.textContent = 'TRY AGAIN';
    }
  }

  private bindControls(): void {
    element<HTMLButtonElement>('initialize-comparison').addEventListener('click', () => { void this.initialize(); });
    window.addEventListener('keydown', (event) => {
      if (event.code === 'Escape' && !event.repeat) {
        this.cancelActiveComparison();
        this.micState.reset();
        this.setNote('Capture cancelled. Hold Space when you are ready.');
        return;
      }
      if (event.code !== 'Space' || event.repeat || isFormControl(event.target) || !this.initialized) return;
      event.preventDefault();
      this.micState.keyDown(event.timeStamp);
    });
    window.addEventListener('keyup', (event) => {
      if (event.code !== 'Space' || isFormControl(event.target) || !this.initialized) return;
      event.preventDefault();
      this.micState.keyUp(event.timeStamp);
    });

    const voicePad = element<HTMLButtonElement>('voice-pad');
    voicePad.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      voicePad.setPointerCapture(event.pointerId);
      this.micState.pointerStart();
    });
    voicePad.addEventListener('pointerup', (event) => {
      event.preventDefault();
      this.micState.pointerEnd();
    });
    voicePad.addEventListener('pointercancel', () => this.micState.pointerEnd());
    element<HTMLButtonElement>('finish-latched').addEventListener('click', () => this.micState.finalize());
    element<HTMLButtonElement>('cancel-latched').addEventListener('click', () => {
      this.cancelActiveComparison();
      this.micState.reset();
      this.setNote('Latched capture cancelled.');
    });
  }

  private async startListening(): Promise<void> {
    this.cancelActiveComparison();
    const generation = ++this.turnGeneration;
    this.chunks = [];
    this.connectedLive.clear();
    this.captureStartedAt = performance.now();
    this.releasedAt = 0;
    this.resetCards();
    this.setNote('Speak naturally. Release Space after your final word leaves your mouth.');

    for (const slot of LIVE_SLOTS) {
      const model = SLOT_MODELS[slot] as GeminiLiveModel;
      this.liveClients.set(slot, new GeminiLiveTranscriptionClient(
        model,
        buildGeminiTranscriptionPrompt(),
        { onTranscript: (text, final) => this.renderLiveTranscript(slot, text, final) },
      ));
    }

    try {
      await this.audio.start((chunk) => {
        if (generation !== this.turnGeneration) return;
        this.chunks.push(chunk.slice(0));
        for (const slot of this.connectedLive) this.liveClients.get(slot)?.send(chunk);
      });
      this.connectionTask = this.connectLiveModels(generation);
      void this.connectionTask.catch((cause) => {
        if (generation !== this.turnGeneration) return;
        for (const slot of LIVE_SLOTS) {
          const transcript = element<HTMLElement>(`${slot}-transcript`);
          if (!this.connectedLive.has(slot) && transcript.classList.contains('provisional')) {
            this.renderModelError(slot, cause);
          }
        }
      });
      this.maxRecordingTimer = window.setTimeout(() => this.micState.finalize(), 30_000);
    } catch (cause) {
      for (const slot of ALL_SLOTS) this.renderModelError(slot, cause);
      this.setNote(cause instanceof Error ? cause.message : 'Microphone capture failed.');
      this.micState.fail();
    }
  }

  private async connectLiveModels(generation: number): Promise<void> {
    const tokens = await this.fetchLiveTokens(true);
    if (generation !== this.turnGeneration) throw new DOMException('Comparison replaced.', 'AbortError');
    const results = await Promise.allSettled(LIVE_SLOTS.map(async (slot) => {
      const model = SLOT_MODELS[slot] as GeminiLiveModel;
      const token = tokens[model];
      if (!token) throw new Error(`${model} returned no temporary Live token.`);
      const client = this.liveClients.get(slot);
      if (!client) throw new Error(`${model} client is unavailable.`);
      await client.connect(token, this.audio.sampleRate);
      if (generation !== this.turnGeneration) throw new DOMException('Comparison replaced.', 'AbortError');
      const bufferedCount = this.chunks.length;
      this.connectedLive.add(slot);
      for (const chunk of this.chunks.slice(0, bufferedCount)) client.send(chunk);
      this.setModelState(slot, 'LIVE');
    }));
    if (generation !== this.turnGeneration) throw new DOMException('Comparison replaced.', 'AbortError');
    results.forEach((result, index) => {
      if (result.status === 'rejected') this.renderModelError(LIVE_SLOTS[index]!, result.reason);
    });
    if (!this.connectedLive.size) throw new Error('Neither Gemini Live model could connect.');
  }

  private async finishListening(): Promise<void> {
    const generation = this.turnGeneration;
    this.releasedAt = performance.now();
    window.clearTimeout(this.maxRecordingTimer);
    await this.audio.stopAndFlushCapturedAudio();
    if (generation !== this.turnGeneration) return;
    this.micState.setProcessing('thinking');

    const duration = pcmDurationMs(this.chunks, this.audio.sampleRate);
    if (duration < 120) {
      for (const slot of ALL_SLOTS) this.renderModelResult(slot, '', 0);
      this.setNote('No usable audio was captured. Hold Space and try again.');
      this.micState.completeTurn();
      return;
    }

    this.requestAbort = new AbortController();
    try {
      await this.connectionTask;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
    }
    if (generation !== this.turnGeneration) return;

    const tasks: Array<Promise<void>> = [];
    for (const slot of LIVE_SLOTS) {
      const client = this.liveClients.get(slot);
      if (!client || !this.connectedLive.has(slot)) continue;
      this.setModelState(slot, 'FINALIZING');
      tasks.push(this.finishLive(slot, client, duration));
    }

    const wav = pcm16ChunksToWav(this.chunks, this.audio.sampleRate);
    for (const slot of BATCH_SLOTS) {
      this.setModelState(slot, 'ANALYZING');
      tasks.push(this.finishBatch(slot, SLOT_MODELS[slot], wav, duration, this.requestAbort.signal));
    }
    await Promise.allSettled(tasks);
    if (generation !== this.turnGeneration) return;

    this.setNote('Pass complete. Compare tail accuracy, release-to-final speed, and estimated cost.');
    this.micState.completeTurn();
  }

  private async finishLive(
    slot: typeof LIVE_SLOTS[number],
    client: GeminiLiveTranscriptionClient,
    durationMs: number,
  ): Promise<void> {
    try {
      const transcript = await client.finish();
      const model = SLOT_MODELS[slot] as GeminiLiveModel;
      this.renderModelResult(
        slot,
        transcript,
        performance.now() - this.releasedAt,
        estimateGeminiLiveCost(model, durationMs, transcript),
      );
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      this.renderModelError(slot, cause);
    }
  }

  private async finishBatch(
    slot: typeof BATCH_SLOTS[number],
    model: GeminiBatchModel,
    wav: Blob,
    durationMs: number,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const response = await fetch(`/api/stt/gemini?model=${encodeURIComponent(model)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
        signal,
      });
      if (!response.ok) throw await apiError(response);
      const payload = await response.json() as GeminiTranscriptResponse;
      this.renderModelResult(
        slot,
        payload.transcript?.trim() ?? '',
        performance.now() - this.releasedAt,
        estimateGeminiBatchCost(model, durationMs, payload.usage),
      );
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') return;
      this.renderModelError(slot, cause);
    }
  }

  private cancelActiveComparison(): void {
    this.turnGeneration += 1;
    window.clearTimeout(this.maxRecordingTimer);
    this.requestAbort?.abort();
    this.requestAbort = undefined;
    this.audio.stop();
    for (const client of this.liveClients.values()) client.close();
    this.liveClients.clear();
    this.connectedLive.clear();
    this.connectionTask = undefined;
  }

  private async fetchLiveTokens(allowSessionRenewal: boolean): Promise<Partial<Record<GeminiLiveModel, string>>> {
    const request = (): Promise<Response> => fetch('/api/gemini-live-token', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ models: GEMINI_LIVE_MODELS }),
    });
    let response = await request();
    if (response.status === 401 && allowSessionRenewal) {
      await this.establishSession();
      response = await request();
    }
    if (!response.ok) throw await apiError(response);
    const payload = await response.json() as GeminiLiveTokenResponse;
    if (!payload.tokens) throw new Error('Gemini returned no Live tokens.');
    return payload.tokens;
  }

  private async establishSession(): Promise<void> {
    const ownerMode = new URLSearchParams(window.location.search).get('owner') === '1';
    if (ownerMode && !this.ownerAccessCode) {
      this.ownerAccessCode = window.prompt('Orion owner access code')?.trim() ?? '';
    }
    await createBrowserSession(this.ownerAccessCode);
  }

  private resetCards(): void {
    for (const slot of ALL_SLOTS) {
      const isLive = LIVE_SLOTS.includes(slot as typeof LIVE_SLOTS[number]);
      this.setModelState(slot, isLive ? 'CONNECTING' : 'CAPTURING');
      element<HTMLElement>(`${slot}-transcript`).textContent = isLive
        ? 'Listening for the first words…'
        : 'Waiting for the completed audio capture.';
      element<HTMLElement>(`${slot}-transcript`).classList.add('provisional');
      element<HTMLElement>(`${slot}-words`).textContent = '— WORDS';
      element<HTMLElement>(`${slot}-latency`).textContent = '— THIS';
      element<HTMLElement>(`${slot}-cost`).textContent = '— COST';
      this.renderHistoricalLatency(slot);
      document.querySelector<HTMLElement>(`[data-model="${slot}"]`)?.classList.remove('has-result', 'has-error');
    }
  }

  private renderLiveTranscript(slot: ComparisonSlot, text: string, final: boolean): void {
    if (!text) return;
    const transcript = element<HTMLElement>(`${slot}-transcript`);
    transcript.textContent = text;
    transcript.classList.toggle('provisional', !final);
    this.setModelState(slot, final ? 'FINAL' : 'LIVE');
  }

  private renderModelResult(
    slot: ComparisonSlot,
    transcript: string,
    latencyMs: number,
    estimatedCostUsd = 0,
  ): void {
    const clean = transcript.trim();
    const transcriptElement = element<HTMLElement>(`${slot}-transcript`);
    transcriptElement.textContent = clean || 'No speech recognized.';
    transcriptElement.classList.remove('provisional');
    this.setModelState(slot, clean ? 'FINAL' : 'EMPTY');
    element<HTMLElement>(`${slot}-words`).textContent = `${wordCount(clean)} WORDS`;
    element<HTMLElement>(`${slot}-latency`).textContent = latencyMs ? `${Math.round(latencyMs)} MS` : '— THIS';
    element<HTMLElement>(`${slot}-cost`).textContent = estimatedCostUsd ? `${formatCost(estimatedCostUsd)} EST.` : '— COST';
    if (latencyMs > 0) {
      const history = this.latencyHistory.get(slot)!;
      history.push(latencyMs);
      if (history.length > 30) history.shift();
      this.renderHistoricalLatency(slot);
    }
    document.querySelector<HTMLElement>(`[data-model="${slot}"]`)?.classList.add('has-result');
  }

  private renderHistoricalLatency(slot: ComparisonSlot): void {
    const history = this.latencyHistory.get(slot) ?? [];
    const p50 = percentile(history, 50);
    const p95 = percentile(history, 95);
    element<HTMLElement>(`${slot}-p50`).textContent = p50 === undefined ? '— P50' : `${Math.round(p50)} P50`;
    element<HTMLElement>(`${slot}-p95`).textContent = p95 === undefined ? '— P95' : `${Math.round(p95)} P95`;
  }

  private renderModelError(slot: ComparisonSlot, cause: unknown): void {
    const message = cause instanceof Error ? cause.message : 'Model request failed.';
    element<HTMLElement>(`${slot}-transcript`).textContent = message;
    element<HTMLElement>(`${slot}-transcript`).classList.remove('provisional');
    this.setModelState(slot, 'ERROR');
    document.querySelector<HTMLElement>(`[data-model="${slot}"]`)?.classList.add('has-error');
  }

  private setModelState(slot: ComparisonSlot, state: string): void {
    element<HTMLElement>(`${slot}-state`).textContent = state;
  }

  private renderMicState(state: MicState): void {
    document.body.dataset.micState = state;
    const labels: Record<MicState, string> = {
      idle: 'READY',
      hold: 'LISTENING',
      latched: 'LATCHED',
      finalizing: 'SEALING AUDIO',
      thinking: 'COMPARING',
      speaking: 'COMPARING',
      error: 'CHECK INPUT',
    };
    element<HTMLElement>('capture-label').textContent = labels[state];
    element<HTMLElement>('latched-actions').hidden = state !== 'latched';
  }

  private setNote(message: string): void {
    element<HTMLElement>('comparison-note').textContent = message;
  }

  private readonly drawWaveform = (): void => {
    const active = ['hold', 'latched', 'finalizing'].includes(this.micState.current);
    const levels = active ? this.audio.readWaveform() : this.waveformBars.map(() => 0);
    this.waveformBars.forEach((bar, index) => {
      const level = levels[index] ?? 0;
      const shaped = active ? 0.16 + Math.pow(level, 0.72) * 0.84 : 0.08;
      bar.style.transform = `scaleY(${shaped})`;
      bar.style.opacity = String(active ? 0.42 + level * 0.58 : 0.16);
    });
    if (active && this.captureStartedAt) {
      const seconds = Math.max(0, performance.now() - this.captureStartedAt) / 1_000;
      element<HTMLElement>('capture-time').textContent = `${seconds.toFixed(1).padStart(4, '0')} S`;
    } else if (this.micState.current === 'idle') {
      element<HTMLElement>('capture-time').textContent = '00.0 S';
    }
    requestAnimationFrame(this.drawWaveform);
  };
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing comparison element: ${id}`);
  return value as T;
}

function isFormControl(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function wordCount(text: string): number {
  return text ? text.split(/\s+/).filter(Boolean).length : 0;
}

function formatCost(value: number): string {
  return `$${value.toFixed(value < 0.001 ? 6 : 5)}`;
}

new SttComparisonController();
