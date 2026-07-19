import { apiError } from './api/providerErrors';
import { MicStateMachine } from './control/micStateMachine';
import { MicrophoneCapture } from './input/microphoneCapture';
import { hasAudiblePcm, pcm16ChunksToWav, pcmDurationMs } from './input/pcmWav';
import { DeepgramStreamingTts } from './output/deepgramStreamingTts';
import { renderScreenMarkdown } from './output/screenMarkdown';
import { StreamingAudioPlayback } from './output/streamingAudio';
import { turnstileToken } from './session/turnstile';
import { PageToolRunner } from './tools/pageToolRunner';
import { appendHistory } from './workflow/conversation';
import {
  GeminiTurnClient,
  type ClientToolCallEvent,
  type GeneratedVoiceTurn,
} from './workflow/geminiTurnClient';
import {
  runOrionVoiceWorkflow,
  type ReceivedVoiceTranscript,
} from './workflow/runOrionVoiceWorkflow';
import type {
  ClientState,
  ClientToolResult,
  ConversationTurn,
  MicState,
  OrbCommand,
  ProviderErrorCode,
  SessionResponse,
  SourceLink,
  VoiceTurnEvent,
} from './types';

export interface OrionVoiceCallbacks {
  onCommand(command: OrbCommand, label: string): boolean;
  getClientState(): Pick<ClientState, 'authority' | 'orb'>;
  onVoiceActivity(active: boolean): void;
  onOutputLevel(level: number): void;
}

interface GeminiTranscriptResponse {
  transcript?: string;
}

/** Connects browser controls and UI state to the master voice workflow. */
export class OrionVoice {
  private readonly audio = new MicrophoneCapture();
  private readonly liveSpeech = new DeepgramStreamingTts();
  private readonly speechPlayer = new StreamingAudioPlayback();
  private readonly micState: MicStateMachine;
  private readonly pageTools: PageToolRunner;
  private readonly geminiTurns: GeminiTurnClient;
  private history: ConversationTurn[] = [];
  private errorRecoveryTimer = 0;
  private capturedPcm: ArrayBuffer[] = [];
  private waveformFrame = 0;
  private toastTimer = 0;
  private responseAbort?: AbortController;
  private transcriptionAbort?: AbortController;
  private speechAbort?: AbortController;
  private progressSpeechAbort?: AbortController;
  private microphoneReady = false;
  private sessionReady = false;
  private latchedIntent = false;
  private clientTurns = 0;
  private expiresAt = 0;
  private ownerSession = false;
  private openAccessSession = false;
  private destroyed = false;
  private quietSince = 0;
  private lastInputWarningAt = 0;
  private ownerAccessCode = '';
  private progressSpeechTimer = 0;
  private progressSpeechFollowupTimer = 0;
  private traceHideTimer = 0;
  private progressSpeechText = '';
  private progressSpeechCount = 0;
  private progressSpeaking = false;
  private earlySpeech?: Promise<void>;
  private earlySpeechText = '';
  private currentScreenText = '';
  private pendingScreenText = '';
  private screenRenderFrame = 0;
  private turnToolCount = 0;
  private turnToolFailures = 0;
  private readonly turnToolNames = new Set<string>();
  private readonly mockMode = new URLSearchParams(window.location.search).get('voice') === 'mock';

  constructor(private readonly callbacks: OrionVoiceCallbacks) {
    this.pageTools = new PageToolRunner({
      onCommand: callbacks.onCommand,
      getClientState: () => this.clientState(),
    });
    this.geminiTurns = new GeminiTurnClient({
      getClientState: () => this.clientState(),
      executeClientTool: (call) => this.pageTools.execute(call),
      onScreenText: (text) => this.showScreenText(text),
      onSpeakableText: (text) => this.startEarlySpeech(text),
      onSources: (sources) => this.showSources(sources),
      onEvent: (event) => this.handleAgentEvent(event),
      onClientToolResult: (call, result) => this.handleClientToolResult(call, result),
    });
    this.micState = new MicStateMachine({
      onStart: (latched) => {
        this.latchedIntent = latched;
        void this.startListening();
      },
      onFinalize: () => {
        this.latchedIntent = false;
        this.finishListening();
      },
      onCancelResponse: () => this.cancelResponse(),
      onState: (state) => this.renderState(state),
    });
    this.bindControls();
    this.waveformFrame = requestAnimationFrame(this.drawWaveform);
    if (this.mockMode) {
      window.__orionTest = {
        transcribe: (text) => { void this.processTranscript(text); },
        expireSession: () => {
          this.sessionReady = false;
          this.expiresAt = 0;
          this.setStatus('SESSION EXPIRED');
          this.setTranscript('Voice session expired. Start a new verified session; hand control remains available.');
        },
        startSpeaking: () => this.micState.setProcessing('speaking'),
      };
    }
  }

  async initialize(): Promise<{ microphone: boolean; session: boolean }> {
    document.body.classList.add('voice-enabled');
    this.liveSpeech.activate();
    if (this.mockMode) {
      this.microphoneReady = true;
      this.sessionReady = true;
      this.expiresAt = Date.now() + 15 * 60_000;
      element<HTMLElement>('voice-ribbon').hidden = false;
      element<HTMLElement>('session-status').textContent = 'SESSION 15:00 / 21 TURNS';
      this.setStatus('VOICE READY');
      this.setTranscript('Hold Space to speak · double-tap to latch');
      return { microphone: true, session: true };
    }
    const [microphone, session] = await Promise.allSettled([
      this.audio.initialize(),
      this.establishSession(),
    ]);
    this.microphoneReady = microphone.status === 'fulfilled';
    this.sessionReady = session.status === 'fulfilled';
    element<HTMLElement>('voice-ribbon').hidden = false;

    if (!this.microphoneReady) {
      this.setStatus('MICROPHONE BLOCKED');
      this.setTranscript('Voice is off. Enable microphone access in Chrome to speak.');
    } else if (!this.sessionReady) {
      this.setStatus('SESSION UNAVAILABLE');
      this.setTranscript(session.status === 'rejected' && session.reason instanceof Error
        ? session.reason.message
        : 'Start a new verified voice session.');
    } else {
      this.setStatus('VOICE READY');
      this.setTranscript('Hold Space to speak · double-tap to latch');
    }
    return { microphone: this.microphoneReady, session: this.sessionReady };
  }

  notify(message: string): void {
    const toast = element<HTMLElement>('orion-toast');
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2_600);
  }

  runSuggestedPrompt(prompt: string): void {
    const text = prompt.trim();
    if (!text) return;
    if (!this.sessionReady) {
      this.notify('START A VOICE SESSION TO RUN THIS PROMPT');
      this.setTranscript('Enter Orion or start a new verified session, then try again.');
      return;
    }
    void this.processTranscript(text);
  }

  async renewSession(): Promise<void> {
    try {
      await this.establishSession();
      this.sessionReady = true;
      this.clientTurns = 0;
      this.setStatus('VOICE READY');
    } catch (error) {
      this.notify(error instanceof Error ? error.message : 'Verification failed.');
    }
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    cancelAnimationFrame(this.waveformFrame);
    cancelAnimationFrame(this.screenRenderFrame);
    window.clearTimeout(this.errorRecoveryTimer);
    window.clearTimeout(this.toastTimer);
    window.clearTimeout(this.progressSpeechTimer);
    window.clearTimeout(this.progressSpeechFollowupTimer);
    window.clearTimeout(this.traceHideTimer);
    this.micState.destroy();
    this.cancelResponse();
    await this.liveSpeech.destroy();
    await this.speechPlayer.destroy();
    await this.audio.destroy();
  }

  private bindControls(): void {
    window.addEventListener('keydown', (event) => {
      if (event.code === 'KeyX' && !event.repeat && !isFormControl(event.target)
        && ['thinking', 'speaking'].includes(this.micState.current)) {
        event.preventDefault();
        this.stopResponse();
        return;
      }
      if (event.code !== 'Space' || event.repeat || isFormControl(event.target)) return;
      event.preventDefault();
      if (!this.canListen()) return;
      document.body.classList.add('voice-engaged');
      this.micState.keyDown(event.timeStamp);
    });
    window.addEventListener('keyup', (event) => {
      if (event.code !== 'Space' || isFormControl(event.target)) return;
      event.preventDefault();
      this.micState.keyUp(event.timeStamp);
    });
    element<HTMLButtonElement>('close-listening').addEventListener('click', () => {
      this.latchedIntent = false;
      this.micState.reset();
      this.audio.stop();
      this.capturedPcm = [];
      this.callbacks.onVoiceActivity(false);
      this.setTranscript('Hold Space to speak · double-tap to latch');
    });
    element<HTMLButtonElement>('finish-listening').addEventListener('click', () => this.micState.finalize());
    element<HTMLButtonElement>('stop-speaking').addEventListener('click', () => this.stopResponse());
    element<HTMLButtonElement>('collapse-answer').addEventListener('click', () => {
      element<HTMLElement>('answer-panel').hidden = true;
    });
  }

  private canListen(): boolean {
    if (!this.microphoneReady) {
      this.notify('MICROPHONE ACCESS IS NOT AVAILABLE');
      return false;
    }
    if (!this.sessionReady
      || (!this.ownerSession && Date.now() >= this.expiresAt)
      || (!this.ownerSession && !this.openAccessSession && this.clientTurns >= 21)) {
      this.sessionReady = false;
      this.setStatus('SESSION EXPIRED');
      this.setTranscript('Voice session ended. Press Space to verify a new session.');
      void this.renewSession();
      return false;
    }
    return true;
  }

  private async startListening(): Promise<void> {
    this.cancelResponse();
    window.clearTimeout(this.errorRecoveryTimer);
    this.capturedPcm = [];
    this.callbacks.onVoiceActivity(true);
    this.setTranscript('Listening…');
    if (this.mockMode) return;
    try {
      await this.audio.start((chunk) => {
        this.capturedPcm.push(chunk.slice(0));
      });
      if (!['hold', 'latched', 'finalizing'].includes(this.micState.current)) this.audio.stop();
    } catch (error) {
      this.audio.stop();
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.micState.fail();
      this.setTranscript(error instanceof Error ? error.message : 'Speech recognition could not start.');
    }
  }

  private async finishListening(): Promise<void> {
    if (this.mockMode) {
      this.setTranscript('Mock listening finalized.');
      this.micState.completeTurn();
      this.callbacks.onVoiceActivity(false);
      return;
    }
    await this.audio.stopAndFlushCapturedAudio();
    if (this.micState.current !== 'finalizing') return;
    const chunks = this.capturedPcm;
    this.capturedPcm = [];
    const durationMs = pcmDurationMs(chunks, this.audio.sampleRate);
    if (durationMs < 140 || !hasAudiblePcm(chunks)) {
      this.micState.fail();
      this.callbacks.onVoiceActivity(false);
      this.setTranscript('No speech detected. Hold Space and try again.');
      window.clearTimeout(this.errorRecoveryTimer);
      this.errorRecoveryTimer = window.setTimeout(() => {
        if (this.micState.current === 'error') this.micState.completeTurn();
      }, 2_000);
      return;
    }
    this.setTranscript('Transcribing…');
    const wav = pcm16ChunksToWav(chunks, this.audio.sampleRate, 16_000);
    try {
      const transcript = await this.transcribeCapturedAudio(wav);
      if (this.micState.current !== 'finalizing') return;
      this.setTranscript(transcript);
      await this.processTranscript(transcript);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.handleError(error);
    }
  }

  private async transcribeCapturedAudio(wav: Blob): Promise<string> {
    const controller = new AbortController();
    this.transcriptionAbort = controller;
    try {
      const response = await fetch('/api/stt/gemini', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'audio/wav' },
        body: wav,
        signal: controller.signal,
      });
      if (!response.ok) throw await apiError(response);
      const payload = await response.json() as GeminiTranscriptResponse;
      const transcript = payload.transcript?.trim() ?? '';
      if (!transcript) throw new Error('No speech detected. Hold Space and try again.');
      return transcript;
    } finally {
      if (this.transcriptionAbort === controller) this.transcriptionAbort = undefined;
    }
  }

  private async processTranscript(raw: string): Promise<void> {
    try {
      const completed = await runOrionVoiceWorkflow(raw, {
        receiveTranscript: (value) => this.receiveVoiceTranscript(value),
        generateGeminiTurn: (transcript) => this.geminiTurns.generateTurn(transcript),
        commitConversationTurn: (transcript, turn) => this.commitConversationTurn(transcript, turn),
        presentGeneratedTurn: async (turn) => {
          if (turn.screenText) this.showScreenText(turn.screenText);
          await this.playAudioOutput(turn);
        },
      });
      if (completed) this.completeTurn();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      this.handleError(error);
    }
  }

  private receiveVoiceTranscript(raw: string): ReceivedVoiceTranscript | null {
    const text = raw.trim();
    if (!text) return null;
    if (this.micState.current === 'thinking' || this.micState.current === 'speaking') return null;

    document.body.classList.add('voice-engaged');
    this.audio.stop();
    this.clientTurns += 1;
    this.setTranscript(text);
    this.micState.setProcessing('thinking');
    this.resetToolTrace();
    this.earlySpeech = undefined;
    this.earlySpeechText = '';
    void this.liveSpeech.prepare().catch(() => undefined);

    const previousHistory = this.history;
    this.history = appendHistory(this.history, { role: 'user', text });
    const controller = new AbortController();
    this.responseAbort = controller;
    return { text, history: previousHistory, controller };
  }

  private commitConversationTurn(
    transcript: ReceivedVoiceTranscript,
    turn: GeneratedVoiceTurn,
  ): void {
    if (this.responseAbort === transcript.controller) this.responseAbort = undefined;
    this.cancelProgressSpeech();
    this.finishToolTrace();
    if (turn.spokenText || turn.screenText) {
      this.history = appendHistory(this.history, {
        role: 'assistant',
        spokenText: turn.spokenText,
        screenText: turn.screenText,
      });
    }
  }

  private async playAudioOutput(turn: GeneratedVoiceTurn): Promise<void> {
    const spokenText = turn.spokenText.trim();
    if (!spokenText) return;
    const orbOnly = this.turnToolNames.size > 0
      && [...this.turnToolNames].every((name) => name.startsWith('orb_'));
    if (orbOnly && spokenText.length < 90) return;
    if (this.earlySpeech) {
      await this.earlySpeech;
      this.earlySpeech = undefined;
      const remainder = spokenText.startsWith(this.earlySpeechText)
        ? spokenText.slice(this.earlySpeechText.length).trim()
        : '';
      if (remainder) await this.speak(remainder);
      return;
    }
    await this.speak(spokenText);
  }

  private startEarlySpeech(answer: string): void {
    if (!answer || this.earlySpeech || this.earlySpeechText) return;
    const orbOnly = this.turnToolNames.size > 0
      && [...this.turnToolNames].every((name) => name.startsWith('orb_'));
    if (orbOnly && answer.trim().length < 90) return;
    this.earlySpeechText = answer;
    this.earlySpeech = this.speak(answer);
  }

  private handleAgentEvent(event: VoiceTurnEvent): void {
    if (event.type === 'tool-start') {
      this.startToolTrace(event.callId, event.tool, event.label);
    } else if (event.type === 'tool-complete') {
      this.completeToolTrace(event.callId, event.summary);
    } else if (event.type === 'tool-failed') {
      this.failToolTrace(event.callId, event.message);
    } else if (event.type === 'progress-speech') {
      this.scheduleProgressSpeech(event.text);
    } else if (event.type === 'scene-command') {
      const accepted = this.callbacks.onCommand(event.command, event.label ?? 'AGENT COMMAND');
      if (!accepted) this.notify('HAND CONTROL ACTIVE · AGENT COMMAND REJECTED');
    }
  }

  private handleClientToolResult(
    call: ClientToolCallEvent,
    result: ClientToolResult,
  ): void {
    if (result.status === 'completed' || result.status === 'popup_blocked') {
      this.completeToolTrace(
        call.callId,
        result.status === 'popup_blocked' ? 'Popup blocked · Open is ready' : 'Action completed',
      );
      return;
    }
    this.failToolTrace(call.callId, result.error ?? 'Action failed');
    if (result.status === 'rejected') this.notify('HAND CONTROL ACTIVE · AGENT COMMAND REJECTED');
  }

  private async speak(spoken: string): Promise<void> {
    if (!spoken) {
      return;
    }
    this.cancelProgressSpeech();
    this.micState.setProcessing('speaking');
    const controller = new AbortController();
    try {
      this.speechAbort = controller;
      try {
        await this.liveSpeech.speak(spoken, controller.signal);
      } catch (streamError) {
        if (controller.signal.aborted) throw streamError;
        const response = await fetch('/api/speech', {
          method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: spoken }), signal: controller.signal,
        });
        if (!response.ok) throw await apiError(response);
        await this.speechPlayer.play(response);
      }
    } catch (error) {
      if (!controller.signal.aborted && !(error instanceof DOMException && error.name === 'AbortError')) {
        try {
          await this.speechPlayer.playSystemFallback(spoken);
        } catch {
          this.notify('VOICE PLAYBACK UNAVAILABLE · FULL RESPONSE PRESERVED');
        }
      }
    } finally {
      if (this.speechAbort === controller) this.speechAbort = undefined;
    }
  }

  private scheduleProgressSpeech(text: string): void {
    if (!text.trim()) return;
    this.progressSpeechText = text.trim().slice(0, 180);
    if (!this.progressSpeechTimer && this.progressSpeechCount === 0) {
      this.progressSpeechTimer = window.setTimeout(() => {
        this.progressSpeechTimer = 0;
        void this.speakProgress(this.progressSpeechText);
      }, 1_200);
    }
    if (!this.progressSpeechFollowupTimer) {
      this.progressSpeechFollowupTimer = window.setTimeout(() => {
        this.progressSpeechFollowupTimer = 0;
        if (this.progressSpeechCount === 1) void this.speakProgress('One more step. I’m still with it.');
      }, 6_000);
    }
  }

  private async speakProgress(text: string): Promise<void> {
    if (!text || this.micState.current !== 'thinking' || this.progressSpeaking || this.progressSpeechCount >= 2) return;
    const controller = new AbortController();
    this.progressSpeechAbort = controller;
    this.progressSpeaking = true;
    this.progressSpeechCount += 1;
    try {
      const response = await fetch('/api/speech', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }), signal: controller.signal,
      });
      if (!response.ok) return;
      await this.speechPlayer.play(response);
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) {
        // Visual progress remains the primary fallback.
      }
    } finally {
      if (this.progressSpeechAbort === controller) this.progressSpeechAbort = undefined;
      this.progressSpeaking = false;
    }
  }

  private cancelProgressSpeech(): void {
    window.clearTimeout(this.progressSpeechTimer);
    window.clearTimeout(this.progressSpeechFollowupTimer);
    this.progressSpeechTimer = 0;
    this.progressSpeechFollowupTimer = 0;
    this.progressSpeechAbort?.abort();
    this.progressSpeechAbort = undefined;
    if (this.progressSpeaking) this.speechPlayer.stop();
    this.progressSpeaking = false;
  }

  private resetToolTrace(): void {
    this.cancelProgressSpeech();
    window.clearTimeout(this.traceHideTimer);
    this.traceHideTimer = 0;
    this.turnToolCount = 0;
    this.turnToolFailures = 0;
    this.turnToolNames.clear();
    this.progressSpeechCount = 0;
    this.progressSpeechText = '';
    const trace = element<HTMLElement>('action-trace');
    trace.hidden = true;
    trace.dataset.complete = 'false';
    element<HTMLOListElement>('action-trace-steps').replaceChildren();
    element<HTMLElement>('action-trace-summary').textContent = '';
    element<HTMLElement>('tool-content').replaceChildren();
    this.showSources([]);
  }

  private startToolTrace(callId: string, tool: string, label: string): void {
    this.turnToolCount += 1;
    this.turnToolNames.add(tool);
    const trace = element<HTMLElement>('action-trace');
    trace.hidden = false;
    trace.dataset.complete = 'false';
    const item = document.createElement('li');
    item.className = 'action-trace__step';
    item.dataset.callId = callId;
    item.dataset.phase = 'active';
    const copy = document.createElement('span');
    copy.textContent = label;
    item.append(copy);
    element<HTMLOListElement>('action-trace-steps').append(item);
  }

  private completeToolTrace(callId: string, summary: string): void {
    const item = this.traceItem(callId);
    if (!item) return;
    item.dataset.phase = 'complete';
    item.title = summary;
  }

  private failToolTrace(callId: string, message: string): void {
    const item = this.traceItem(callId);
    if (!item) return;
    item.dataset.phase = 'failed';
    this.turnToolFailures += 1;
    item.title = message;
    element<HTMLElement>('action-trace-summary').textContent = message.slice(0, 120);
  }

  private finishToolTrace(): void {
    if (!this.turnToolCount) return;
    const trace = element<HTMLElement>('action-trace');
    trace.dataset.complete = 'true';
    const completed = this.turnToolCount - this.turnToolFailures;
    element<HTMLElement>('action-trace-summary').textContent = this.turnToolFailures
      ? `${completed} completed · ${this.turnToolFailures} failed`
      : `${completed} action${completed === 1 ? '' : 's'} completed`;
    window.clearTimeout(this.traceHideTimer);
    this.traceHideTimer = window.setTimeout(() => { trace.hidden = true; }, 3_800);
  }

  private traceItem(callId: string): HTMLElement | null {
    return [...element<HTMLOListElement>('action-trace-steps').children]
      .find((child) => child instanceof HTMLElement && child.dataset.callId === callId) as HTMLElement | undefined ?? null;
  }

  private clientState(): ClientState {
    const base = this.callbacks.getClientState();
    const answerVisible = !element<HTMLElement>('answer-panel').hidden;
    return {
      ...base,
      microphone: this.micState.current,
      fullscreen: Boolean(document.fullscreenElement),
      screen: {
        visible: answerVisible,
        text: this.currentScreenText.slice(0, 2_000),
      },
      ...(document.body.classList.contains('guide-open')
        ? { visiblePanel: 'guide' }
        : answerVisible ? { visiblePanel: 'answer' } : {}),
    };
  }

  private completeTurn(): void {
    this.callbacks.onVoiceActivity(false);
    if (this.latchedIntent && this.canListen()) {
      window.setTimeout(() => this.micState.latch(), 180);
    } else {
      this.micState.completeTurn();
    }
  }

  private cancelResponse(): void {
    this.transcriptionAbort?.abort();
    this.responseAbort?.abort();
    this.speechAbort?.abort();
    this.cancelProgressSpeech();
    this.transcriptionAbort = undefined;
    this.responseAbort = undefined;
    this.speechAbort = undefined;
    this.earlySpeech = undefined;
    this.earlySpeechText = '';
    this.liveSpeech.stop();
    this.speechPlayer.stop();
  }

  private stopResponse(): void {
    this.latchedIntent = false;
    this.cancelResponse();
    this.callbacks.onVoiceActivity(false);
    this.micState.completeTurn();
    this.setTranscript('Voice stopped · hold Space to speak');
  }

  private renderState(state: MicState): void {
    if (state === 'latched') {
      this.latchedIntent = true;
    }
    document.body.dataset.mic = state;
    const label = state === 'hold' || state === 'latched'
      ? 'LISTENING'
      : state === 'finalizing'
        ? 'TRANSCRIBING'
        : state === 'thinking'
        ? 'THINKING'
        : state === 'speaking'
          ? 'SPEAKING'
          : state === 'error'
            ? 'VOICE ERROR'
            : this.sessionReady ? 'VOICE READY' : 'VOICE OFFLINE';
    this.setStatus(label);
    const latched = state === 'latched';
    element<HTMLButtonElement>('close-listening').hidden = !latched;
    element<HTMLButtonElement>('finish-listening').hidden = !latched;
    element<HTMLButtonElement>('stop-speaking').hidden = state !== 'speaking' && state !== 'thinking';
  }

  private setStatus(text: string): void {
    element<HTMLElement>('voice-status').textContent = text;
  }

  private setTranscript(text: string, interim = false): void {
    const node = element<HTMLElement>('live-transcript');
    node.textContent = text;
    node.classList.toggle('is-interim', interim);
  }

  private showScreenText(text: string): void {
    const panel = element<HTMLElement>('answer-panel');
    panel.hidden = false;
    this.currentScreenText = text.slice(0, 12_000);
    this.pendingScreenText = this.currentScreenText;
    if (this.screenRenderFrame) return;
    this.screenRenderFrame = requestAnimationFrame(() => {
      this.screenRenderFrame = 0;
      renderScreenMarkdown(element<HTMLElement>('answer-text'), this.pendingScreenText);
    });
  }

  private showSources(sources: SourceLink[]): void {
    const container = element<HTMLElement>('answer-sources');
    container.replaceChildren(...sources.map((source) => {
      const link = document.createElement('a');
      link.href = source.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = source.title;
      return link;
    }));
  }

  private handleError(error: unknown): void {
    this.cancelResponse();
    const provider = error as Error & { code?: ProviderErrorCode };
    if (provider.code === 'quota_exhausted') {
      this.setTranscript('ORION IS TEMPORARILY AT CAPACITY · THE VOICE API LIMIT HAS BEEN REACHED. HAND CONTROL REMAINS AVAILABLE.');
    } else if (provider.code === 'session_expired') {
      this.sessionReady = false;
      this.setTranscript('Voice session expired. Start a new verified session; hand control remains available.');
    } else {
      this.setTranscript(provider.message || 'Orion is temporarily unavailable. Hand control remains available.');
    }
    this.micState.fail();
    this.callbacks.onVoiceActivity(false);
  }

  private async establishSession(): Promise<void> {
    const token = await turnstileToken();
    const ownerInput = element<HTMLInputElement>('owner-access-code');
    const ownerToken = this.ownerAccessCode || ownerInput.value.trim();
    const response = await fetch('/api/session', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(token ? { turnstileToken: token } : {}),
        ...(ownerToken ? { ownerToken } : {}),
      }),
    });
    if (!response.ok) throw await apiError(response);
    const session = await response.json() as SessionResponse;
    this.ownerSession = session.owner === true;
    this.openAccessSession = session.openAccess === true;
    if (session.owner && ownerToken) {
      this.ownerAccessCode = ownerToken;
      ownerInput.value = '';
    }
    this.expiresAt = session.expiresAt ?? Number.POSITIVE_INFINITY;
    element<HTMLElement>('session-status').textContent = session.owner
      ? 'OWNER SESSION · UNLIMITED'
      : session.openAccess
        ? 'RECRUITER ACCESS · UNLIMITED'
        : 'SESSION 15:00 / 21 TURNS';
  }

  private drawWaveform = (): void => {
    if (this.destroyed) return;
    const listening = ['hold', 'latched'].includes(this.micState.current);
    const speaking = this.micState.current === 'speaking' || this.progressSpeaking;
    const values = listening
      ? this.audio.readWaveform().slice(0, 20)
      : speaking
        ? mergeWaveforms(this.liveSpeech.readWaveform(20), this.speechPlayer.readWaveform(20))
        : Array.from({ length: 20 }, (_, index) => 0.05 + Math.sin(index * 0.7) * 0.015);
    document.querySelectorAll<HTMLElement>('#waveform i').forEach((bar, index) => {
      bar.style.setProperty('--level', String(Math.max(0.04, values[index] ?? 0)));
    });
    if (speaking) {
      const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
      const peak = Math.max(0, ...values);
      this.callbacks.onOutputLevel(Math.min(1, mean * 1.15 + peak * 0.28));
    } else {
      this.callbacks.onOutputLevel(0);
    }
    if (listening) this.monitorInputLevel();
    else this.quietSince = 0;
    this.waveformFrame = requestAnimationFrame(this.drawWaveform);
  };

  private monitorInputLevel(): void {
    const now = performance.now();
    const level = this.audio.readInputLevel();
    if (level.clipping && now - this.lastInputWarningAt > 3_000) {
      this.lastInputWarningAt = now;
      this.notify('MIC LEVEL HIGH · MOVE SLIGHTLY BACK');
      return;
    }
    if (level.rms >= 0.006) {
      this.quietSince = 0;
      return;
    }
    this.quietSince ||= now;
    if (now - this.quietSince > 1_400 && now - this.lastInputWarningAt > 3_000) {
      this.lastInputWarningAt = now;
      this.notify('MIC LEVEL LOW · MOVE CLOSER OR SPEAK UP');
    }
  }
}

function isFormControl(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement;
}

function element<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing Orion interface element: ${id}`);
  return node as T;
}

function mergeWaveforms(primary: number[], fallback: number[]): number[] {
  return Array.from({ length: Math.max(primary.length, fallback.length) }, (_, index) =>
    Math.max(primary[index] ?? 0, fallback[index] ?? 0));
}

declare global {
  interface Window {
    __orionTest?: {
      transcribe(text: string): void;
      expireSession(): void;
      startSpeaking(): void;
    };
  }
}
