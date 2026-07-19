export interface DeepgramCallbacks {
  onTranscript(text: string, final: boolean): void;
  onDisconnected(message: string): void;
}

interface TokenResponse {
  token?: string;
  access_token?: string;
}

interface FinalSegment {
  start: number;
  text: string;
}

const FINAL_RESULT_IDLE_MS = 600;
const FINAL_RESULT_TIMEOUT_MS = 1_600;

export const ORION_KEYTERMS = [
  'Orion',
  'orb',
  'orbs',
  'ball',
  'balls',
  'sphere',
  'solar core',
  'light source',
  'Gemini',
  'Deepgram',
  'Jarvis',
  'open the orb',
  'expand the orb',
  'unfold the orb',
  'disperse the orb',
  'field open',
  'open the field',
  'expand the field',
  'field collapse',
  'collapse the field',
  'close the field',
  'retract the field',
  'dual control',
  'disperse',
  'burst',
  'blast',
  'release energy',
  'zoom in',
  'zoom inside',
  'zoom out',
  'rotate left',
  'rotate right',
  'tilt up',
  'tilt down',
  'spin',
  'x axis',
  'y axis',
  'z axis',
  'stop motion',
  'increase brightness',
  'decrease brightness',
  'core size',
  'increase energy',
  'reset',
  'restore the orb',
];

export class DeepgramNovaClient {
  private socket?: WebSocket;
  private ready?: Promise<void>;
  private settled = false;
  private closed = false;
  private finalRequested = false;
  private finalMessageSent = false;
  private finalSegments: FinalSegment[] = [];
  private pendingInterim = '';
  private finalizeTimer = 0;
  private autoFinalize = false;

  constructor(private readonly callbacks: DeepgramCallbacks) {}

  async connect(sampleRate: number): Promise<void> {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.closed = false;
    this.settled = false;
    this.finalRequested = false;
    this.finalMessageSent = false;
    this.finalSegments = [];
    this.pendingInterim = '';
    window.clearTimeout(this.finalizeTimer);
    this.finalizeTimer = 0;
    const response = await fetch('/api/deepgram-token', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) throw await responseError(response, 'Speech recognition could not start.');
    const body = await response.json() as TokenResponse;
    const token = body.token ?? body.access_token;
    if (!token) throw new Error('The speech token response was incomplete.');
    if (this.closed) throw new DOMException('Speech turn closed.', 'AbortError');

    const url = buildDeepgramListenUrl(sampleRate);

    this.socket = new WebSocket(url, ['bearer', token]);
    this.ready = new Promise((resolve, reject) => {
      const socket = this.socket!;
      const timeout = window.setTimeout(() => reject(new Error('Speech recognition timed out.')), 8_000);
      socket.binaryType = 'arraybuffer';
      socket.onopen = () => {
        window.clearTimeout(timeout);
        if (this.closed) {
          socket.close(1000, 'turn closed');
          reject(new DOMException('Speech turn closed.', 'AbortError'));
          return;
        }
        resolve();
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('Speech recognition disconnected.'));
      };
      socket.onmessage = (event) => this.handleMessage(String(event.data));
      socket.onclose = (event) => {
        if (this.finalRequested) this.completeFinalization();
        if (!this.settled) this.callbacks.onDisconnected(event.reason || 'Speech recognition disconnected.');
      };
    });
    await this.ready;
  }

  send(chunk: ArrayBuffer): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(chunk);
  }

  setAutoFinalize(enabled: boolean): void {
    this.autoFinalize = enabled;
  }

  requestFinal(): void {
    this.finalRequested = true;
    if (this.socket?.readyState !== WebSocket.OPEN || this.finalMessageSent) return;
    this.finalMessageSent = true;
    this.socket.send(JSON.stringify({ type: 'Finalize' }));
    this.scheduleFinalization(FINAL_RESULT_TIMEOUT_MS);
  }

  close(): void {
    this.closed = true;
    this.settled = true;
    window.clearTimeout(this.finalizeTimer);
    this.finalizeTimer = 0;
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'CloseStream' }));
      this.socket.close(1000, 'turn complete');
    }
    this.socket = undefined;
  }

  private handleMessage(raw: string): void {
    try {
      const message = JSON.parse(raw) as Record<string, unknown>;
      if (message.type === 'UtteranceEnd') {
        if (this.autoFinalize || this.finalRequested) this.completeFinalization();
        return;
      }
      const transcript = extractTranscript(message);
      const isFinalSegment = message.is_final === true;
      if (transcript && isFinalSegment) this.appendFinalSegment(transcript, message.start);
      this.pendingInterim = isFinalSegment ? '' : transcript;
      const combined = this.combinedTranscript();
      if (combined) this.callbacks.onTranscript(combined, false);

      if (this.autoFinalize && message.speech_final === true) {
        this.completeFinalization();
      } else if (this.finalRequested && message.from_finalize === true) {
        this.completeFinalization();
      } else if (this.finalRequested && isFinalSegment) {
        // Deepgram documents that from_finalize is not guaranteed. Once the
        // frozen stream has produced a final segment, a short quiet window is
        // the terminal signal when that flag is absent.
        this.scheduleFinalization(FINAL_RESULT_IDLE_MS);
      }
    } catch {
      // Deepgram may add non-transcript event types; ignore those safely.
    }
  }

  private appendFinalSegment(text: string, startValue: unknown): void {
    const lastStart = this.finalSegments.at(-1)?.start ?? -1;
    const start = typeof startValue === 'number' && Number.isFinite(startValue)
      ? startValue
      : lastStart + 0.000_001;
    const existing = this.finalSegments.find((segment) => Math.abs(segment.start - start) < 0.000_000_1);
    if (existing) existing.text = text;
    else this.finalSegments.push({ start, text });
    this.finalSegments.sort((left, right) => left.start - right.start);
  }

  private combinedTranscript(): string {
    return joinTranscript(this.finalSegments.map((segment) => segment.text), this.pendingInterim);
  }

  private scheduleFinalization(delayMs: number): void {
    window.clearTimeout(this.finalizeTimer);
    this.finalizeTimer = window.setTimeout(() => this.completeFinalization(), delayMs);
  }

  private completeFinalization(): void {
    if (this.settled) return;
    const transcript = this.combinedTranscript();
    if (!transcript) return;
    this.settled = true;
    window.clearTimeout(this.finalizeTimer);
    this.finalizeTimer = 0;
    this.callbacks.onTranscript(transcript, true);
  }
}

export function buildDeepgramListenUrl(sampleRate: number): URL {
  const url = new URL('wss://api.deepgram.com/v1/listen');
  url.searchParams.set('model', 'nova-3');
  url.searchParams.set('language', 'en-US');
  url.searchParams.set('encoding', 'linear16');
  url.searchParams.set('sample_rate', String(Math.round(sampleRate)));
  url.searchParams.set('channels', '1');
  url.searchParams.set('interim_results', 'true');
  url.searchParams.set('smart_format', 'true');
  url.searchParams.set('punctuate', 'true');
  url.searchParams.set('endpointing', '500');
  url.searchParams.set('utterance_end_ms', '1000');
  ORION_KEYTERMS.forEach((term) => url.searchParams.append('keyterm', term));
  return url;
}

function joinTranscript(segments: string[], interim: string): string {
  return [...segments, interim].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function extractTranscript(message: Record<string, unknown>): string {
  if (typeof message.transcript === 'string') return message.transcript.trim();
  const channel = message.channel as { alternatives?: Array<{ transcript?: string }> } | undefined;
  return channel?.alternatives?.[0]?.transcript?.trim() ?? '';
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  try {
    const body = await response.json() as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}
