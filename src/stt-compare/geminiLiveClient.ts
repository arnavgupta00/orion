import type { GeminiLiveModel } from './geminiModels';
import { createGeminiLiveSetup } from './geminiModels';

const LIVE_ENDPOINT = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained';

interface GeminiLiveCallbacks {
  onTranscript: (text: string, final: boolean) => void;
}

interface GeminiLiveMessage {
  setupComplete?: Record<string, never>;
  serverContent?: {
    inputTranscription?: { text?: string };
    turnComplete?: boolean;
    generationComplete?: boolean;
  };
}

export class GeminiLiveTranscriptionClient {
  private socket?: WebSocket;
  private transcript = '';
  private sampleRate = 48_000;
  private finishing = false;
  private settled = false;
  private quietTimer = 0;
  private hardTimer = 0;
  private finishResolve?: (value: string) => void;
  private finishReject?: (reason: unknown) => void;

  constructor(
    readonly model: GeminiLiveModel,
    private readonly transcriptionInstruction: string,
    private readonly callbacks: GeminiLiveCallbacks,
  ) {}

  connect(token: string, sampleRate: number): Promise<void> {
    this.sampleRate = sampleRate;
    return new Promise((resolve, reject) => {
      const url = `${LIVE_ENDPOINT}?access_token=${encodeURIComponent(token)}`;
      const socket = new WebSocket(url);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      let ready = false;
      const setupTimer = window.setTimeout(() => {
        const error = new Error(`${this.model} did not complete Live setup.`);
        socket.close(1000, 'Setup timeout');
        reject(error);
      }, 8_000);

      socket.addEventListener('open', () => {
        socket.send(JSON.stringify({
          setup: createGeminiLiveSetup(this.model, this.transcriptionInstruction),
        }));
      });
      socket.addEventListener('message', (event) => { void (async () => {
        const message = await decodeLiveMessage(event.data);
        if (!message) return;
        if (message.setupComplete && !ready) {
          ready = true;
          window.clearTimeout(setupTimer);
          socket.send(JSON.stringify({ realtimeInput: { activityStart: {} } }));
          resolve();
        }
        this.consumeServerMessage(message);
      })(); });
      socket.addEventListener('error', () => {
        const error = new Error(`${this.model} Live connection failed.`);
        window.clearTimeout(setupTimer);
        if (!ready) reject(error);
        else this.rejectFinish(error);
      });
      socket.addEventListener('close', (event) => {
        window.clearTimeout(setupTimer);
        if (this.settled) return;
        const error = new Error(event.reason || `${this.model} Live connection closed early (${event.code}).`);
        if (!ready) reject(error);
        else if (this.finishing && this.transcript) this.resolveFinish();
        else this.rejectFinish(error);
      });
    });
  }

  send(chunk: ArrayBuffer): void {
    if (this.socket?.readyState !== WebSocket.OPEN || this.finishing) return;
    this.socket.send(JSON.stringify({
      realtimeInput: {
        audio: {
          data: arrayBufferToBase64(chunk),
          mimeType: `audio/pcm;rate=${this.sampleRate}`,
        },
      },
    }));
  }

  finish(): Promise<string> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`${this.model} Live connection is unavailable.`));
    }
    this.finishing = true;
    this.socket.send(JSON.stringify({ realtimeInput: { activityEnd: {} } }));
    return new Promise<string>((resolve, reject) => {
      this.finishResolve = resolve;
      this.finishReject = reject;
      this.hardTimer = window.setTimeout(() => {
        if (this.transcript) this.resolveFinish();
        else this.rejectFinish(new Error(`${this.model} returned no transcription.`));
      }, 5_000);
      this.scheduleQuietFinish(700);
    });
  }

  close(): void {
    if (this.settled && !this.socket) return;
    this.settled = true;
    window.clearTimeout(this.quietTimer);
    window.clearTimeout(this.hardTimer);
    this.socket?.close(1000, 'Comparison cancelled');
    this.socket = undefined;
    this.finishReject?.(new DOMException('Comparison cancelled.', 'AbortError'));
    this.finishResolve = undefined;
    this.finishReject = undefined;
  }

  private consumeServerMessage(message: GeminiLiveMessage): void {
    const incoming = message.serverContent?.inputTranscription?.text;
    if (incoming) {
      this.transcript = mergeLiveTranscript(this.transcript, incoming);
      this.callbacks.onTranscript(this.transcript, false);
      if (this.finishing) this.scheduleQuietFinish(450);
    }
    if (this.finishing && (message.serverContent?.turnComplete || message.serverContent?.generationComplete)) {
      this.scheduleQuietFinish(450);
    }
  }

  private scheduleQuietFinish(delayMs: number): void {
    window.clearTimeout(this.quietTimer);
    this.quietTimer = window.setTimeout(() => {
      if (this.transcript) this.resolveFinish();
    }, delayMs);
  }

  private resolveFinish(): void {
    if (this.settled) return;
    this.settled = true;
    window.clearTimeout(this.quietTimer);
    window.clearTimeout(this.hardTimer);
    const transcript = this.transcript.trim();
    this.callbacks.onTranscript(transcript, true);
    this.finishResolve?.(transcript);
    this.finishResolve = undefined;
    this.finishReject = undefined;
    this.socket?.close(1000, 'Transcription complete');
    this.socket = undefined;
  }

  private rejectFinish(error: unknown): void {
    if (this.settled) return;
    this.settled = true;
    window.clearTimeout(this.quietTimer);
    window.clearTimeout(this.hardTimer);
    this.finishReject?.(error);
    this.finishResolve = undefined;
    this.finishReject = undefined;
  }
}

export function mergeLiveTranscript(existing: string, incoming: string): string {
  const current = existing.trim();
  const next = incoming.trim();
  if (!current) return next;
  if (!next || current.endsWith(next)) return current;
  if (next.startsWith(current)) return next;
  if (current.startsWith(next)) return current;

  const maxOverlap = Math.min(current.length, next.length);
  for (let size = maxOverlap; size >= 2; size -= 1) {
    if (current.slice(-size).toLocaleLowerCase() === next.slice(0, size).toLocaleLowerCase()) {
      return `${current}${next.slice(size)}`;
    }
  }
  const separator = /[\s([{\-/'\u2018\u201c]$/.test(current) || /^[\s.,!?;:)}\]\-'\u2019\u201d]/.test(next) ? '' : ' ';
  return `${current}${separator}${next}`;
}

export async function decodeLiveMessage(data: unknown): Promise<GeminiLiveMessage | undefined> {
  let text: string;
  if (typeof data === 'string') text = data;
  else if (data instanceof Blob) text = await data.text();
  else if (data instanceof ArrayBuffer) text = new TextDecoder().decode(data);
  else if (ArrayBuffer.isView(data)) {
    text = new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  } else return undefined;

  try {
    return JSON.parse(text) as GeminiLiveMessage;
  } catch {
    return undefined;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
