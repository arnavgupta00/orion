import { ORION_KEYTERMS } from '../voice/input/deepgramClient';

export type DeepgramComparisonModel = 'flux' | 'nova';

export interface DeepgramComparisonCallbacks {
  onTranscript(text: string, final: boolean): void;
}

interface FinalSegment {
  start: number;
  text: string;
}

export class DeepgramComparisonClient {
  private socket?: WebSocket;
  private latestTranscript = '';
  private readonly novaSegments: FinalSegment[] = [];
  private novaInterim = '';
  private readonly fluxTurns = new Map<number, string>();
  private finalRequested = false;
  private settled = false;
  private manuallyClosed = false;
  private finishTimer = 0;
  private finishResolve?: (text: string) => void;
  private finishReject?: (error: Error) => void;

  constructor(
    readonly model: DeepgramComparisonModel,
    private readonly callbacks: DeepgramComparisonCallbacks,
  ) {}

  async connect(sampleRate: number, token: string): Promise<void> {
    const socket = new WebSocket(buildComparisonListenUrl(this.model, sampleRate), ['bearer', token]);
    this.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error(`${this.label} connection timed out.`)), 8_000);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error(`${this.label} disconnected.`));
      };
      socket.onmessage = (event) => this.handleMessage(String(event.data));
      socket.onclose = (event) => {
        window.clearTimeout(timeout);
        if (this.finalRequested) this.settle(this.latestTranscript);
        else if (!this.manuallyClosed && !this.settled) this.fail(new Error(event.reason || `${this.label} disconnected.`));
      };
    });
  }

  send(chunk: ArrayBuffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(chunk);
  }

  finish(): Promise<string> {
    if (this.settled) return Promise.resolve(this.latestTranscript);
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`${this.label} is not connected.`));
    }
    this.finalRequested = true;
    const result = new Promise<string>((resolve, reject) => {
      this.finishResolve = resolve;
      this.finishReject = reject;
    });
    this.socket.send(JSON.stringify({ type: this.model === 'flux' ? 'CloseStream' : 'Finalize' }));
    this.finishTimer = window.setTimeout(() => this.settle(this.latestTranscript), this.model === 'flux' ? 4_000 : 1_600);
    return result;
  }

  close(): void {
    this.manuallyClosed = true;
    window.clearTimeout(this.finishTimer);
    if (this.finishReject && !this.settled) {
      this.settled = true;
      this.finishReject(new DOMException('Comparison cancelled.', 'AbortError'));
    }
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.close(1000, 'comparison cancelled');
    this.socket = undefined;
  }

  private get label(): string {
    return this.model === 'flux' ? 'Flux' : 'Nova-3';
  }

  private handleMessage(raw: string): void {
    try {
      const message = JSON.parse(raw) as Record<string, unknown>;
      if (this.model === 'flux') this.handleFlux(message);
      else this.handleNova(message);
    } catch {
      // Ignore metadata and future protocol messages that contain no transcript.
    }
  }

  private handleFlux(message: Record<string, unknown>): void {
    if (message.type !== 'TurnInfo' || typeof message.transcript !== 'string') return;
    const turnIndex = typeof message.turn_index === 'number' ? message.turn_index : 0;
    const transcript = message.transcript.trim();
    if (transcript) this.fluxTurns.set(turnIndex, transcript);
    this.latestTranscript = [...this.fluxTurns.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, text]) => text)
      .join(' ')
      .trim();
    if (this.latestTranscript) this.callbacks.onTranscript(this.latestTranscript, message.event === 'EndOfTurn');
    if (this.finalRequested && message.event === 'EndOfTurn') this.settle(this.latestTranscript);
  }

  private handleNova(message: Record<string, unknown>): void {
    const channel = message.channel as { alternatives?: Array<{ transcript?: string }> } | undefined;
    const transcript = channel?.alternatives?.[0]?.transcript?.trim() ?? '';
    if (message.type !== 'Results') return;
    const isFinal = message.is_final === true;
    if (transcript && isFinal) this.appendNovaSegment(transcript, message.start);
    this.novaInterim = isFinal ? '' : transcript;
    this.latestTranscript = [...this.novaSegments.map((segment) => segment.text), this.novaInterim]
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (this.latestTranscript) this.callbacks.onTranscript(this.latestTranscript, isFinal);
    if (!this.finalRequested) return;
    if (message.from_finalize === true) this.settle(this.latestTranscript);
    else if (isFinal) {
      window.clearTimeout(this.finishTimer);
      this.finishTimer = window.setTimeout(() => this.settle(this.latestTranscript), 500);
    }
  }

  private appendNovaSegment(text: string, startValue: unknown): void {
    const fallback = (this.novaSegments.at(-1)?.start ?? -1) + 0.000_001;
    const start = typeof startValue === 'number' && Number.isFinite(startValue) ? startValue : fallback;
    const existing = this.novaSegments.find((segment) => Math.abs(segment.start - start) < 0.000_000_1);
    if (existing) existing.text = text;
    else this.novaSegments.push({ start, text });
    this.novaSegments.sort((left, right) => left.start - right.start);
  }

  private settle(text: string): void {
    if (this.settled) return;
    this.settled = true;
    window.clearTimeout(this.finishTimer);
    this.latestTranscript = text.trim();
    this.callbacks.onTranscript(this.latestTranscript, true);
    this.finishResolve?.(this.latestTranscript);
    this.finishResolve = undefined;
    this.finishReject = undefined;
    if (this.model === 'nova' && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
      this.socket.close(1000, 'comparison complete');
    }
  }

  private fail(error: Error): void {
    if (this.settled) return;
    this.settled = true;
    window.clearTimeout(this.finishTimer);
    this.finishReject?.(error);
    this.finishResolve = undefined;
    this.finishReject = undefined;
  }
}

export function buildComparisonListenUrl(model: DeepgramComparisonModel, sampleRate: number): string {
  const flux = model === 'flux';
  const url = new URL(flux ? 'wss://api.deepgram.com/v2/listen' : 'wss://api.deepgram.com/v1/listen');
  url.searchParams.set('model', flux ? 'flux-general-en' : 'nova-3');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', String(Math.round(sampleRate)));
  if (flux) {
    url.searchParams.set('eot_threshold', '0.7');
    url.searchParams.set('eot_timeout_ms', '1000');
  } else {
    url.searchParams.set('language', 'en-US');
    url.searchParams.set('channels', '1');
    url.searchParams.set('interim_results', 'true');
    url.searchParams.set('smart_format', 'true');
    url.searchParams.set('punctuate', 'true');
    url.searchParams.set('endpointing', '500');
    url.searchParams.set('utterance_end_ms', '1000');
  }
  ORION_KEYTERMS.forEach((term) => url.searchParams.append('keyterm', term));
  return url.toString();
}
