import { apiError } from '../api/providerErrors';

const OUTPUT_SAMPLE_RATE = 24_000;
const CONNECT_TIMEOUT_MS = 8_000;
const SPEECH_TIMEOUT_MS = 25_000;

interface DeepgramTokenResponse {
  token?: string;
  access_token?: string;
  ttsModel?: string;
}

interface ActiveSpeech {
  version: number;
  receivedAudio: boolean;
  flushed: boolean;
  pendingSources: number;
  resolve(): void;
  reject(error: Error): void;
  timeout: number;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Keeps a browser-to-Deepgram TTS socket warm while Gemini is thinking and
 * schedules raw PCM chunks directly on Web Audio as soon as they arrive.
 */
export class DeepgramStreamingTts {
  private socket?: WebSocket;
  private connecting?: Promise<void>;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private speech?: ActiveSpeech;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private nextStartTime = 0;
  private version = 0;
  private trailingByte: number | undefined;
  private destroyed = false;
  private model = 'aura-2-orion-en';

  activate(): void {
    if (this.destroyed) return;
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    this.analyser ??= this.createAnalyser(this.context);
    if (this.context.state === 'suspended') void this.context.resume().catch(() => undefined);
  }

  async prepare(): Promise<void> {
    if (this.destroyed) throw new DOMException('Speech player closed.', 'AbortError');
    this.activate();
    if (this.socket?.readyState === WebSocket.OPEN) return;
    if (this.connecting) return this.connecting;
    const connecting = this.openSocket();
    this.connecting = connecting;
    try {
      await connecting;
    } finally {
      if (this.connecting === connecting) this.connecting = undefined;
    }
  }

  async speak(text: string, signal?: AbortSignal): Promise<void> {
    const spoken = text.trim();
    if (!spoken) return;
    if (signal?.aborted) throw new DOMException('Speech stopped.', 'AbortError');
    await this.prepare();
    const context = this.context;
    const socket = this.socket;
    if (!context || !socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Streaming speech is not connected.');
    }
    if (context.state === 'suspended') await context.resume();

    this.stop();
    const version = ++this.version;
    this.nextStartTime = context.currentTime + 0.018;
    this.trailingByte = undefined;

    const playback = new Promise<void>((resolve, reject) => {
      const speech: ActiveSpeech = {
        version,
        receivedAudio: false,
        flushed: false,
        pendingSources: 0,
        resolve,
        reject,
        timeout: window.setTimeout(() => {
          this.failSpeech(new Error('Streaming speech timed out.'), version);
        }, SPEECH_TIMEOUT_MS),
        ...(signal ? { signal } : {}),
      };
      if (signal) {
        speech.onAbort = () => this.stop();
        signal.addEventListener('abort', speech.onAbort, { once: true });
      }
      this.speech = speech;
    });

    try {
      socket.send(JSON.stringify({ type: 'Speak', text: spoken }));
      socket.send(JSON.stringify({ type: 'Flush' }));
    } catch (error) {
      this.failSpeech(error instanceof Error ? error : new Error('Streaming speech could not start.'), version);
    }
    return playback;
  }

  stop(): void {
    this.version += 1;
    if ((this.speech || this.sources.size) && this.socket?.readyState === WebSocket.OPEN) {
      try { this.socket.send(JSON.stringify({ type: 'Clear' })); } catch { /* the fallback path will recover */ }
    }
    this.sources.forEach((source) => {
      try { source.stop(); } catch { /* source already ended */ }
      source.disconnect();
    });
    this.sources.clear();
    this.nextStartTime = 0;
    this.trailingByte = undefined;
    if (this.speech) this.settleSpeech(this.speech, new DOMException('Speech stopped.', 'AbortError'));
  }

  readWaveform(size = 20): number[] {
    if (!this.analyser || (!this.speech && !this.sources.size)) {
      return Array.from({ length: size }, () => 0);
    }
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return Array.from({ length: size }, (_, index) => {
      const sample = data[Math.min(data.length - 1, Math.floor(index * data.length / size))] ?? 0;
      return Math.min(1, sample / 210);
    });
  }

  async destroy(): Promise<void> {
    this.destroyed = true;
    this.stop();
    const socket = this.socket;
    this.socket = undefined;
    if (socket?.readyState === WebSocket.OPEN) {
      try { socket.send(JSON.stringify({ type: 'Close' })); } catch { /* socket is already closing */ }
      socket.close(1000, 'Orion closed');
    } else if (socket?.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    this.analyser?.disconnect();
    this.analyser = undefined;
    await this.context?.close();
    this.context = undefined;
  }

  private async openSocket(): Promise<void> {
    const response = await fetch('/api/deepgram-token', {
      method: 'POST',
      credentials: 'same-origin',
    });
    if (!response.ok) throw await apiError(response);
    const body = await response.json() as DeepgramTokenResponse;
    const token = body.token ?? body.access_token;
    if (!token) throw new Error('The Deepgram voice token response was incomplete.');
    if (body.ttsModel) this.model = body.ttsModel;
    if (this.destroyed) throw new DOMException('Speech player closed.', 'AbortError');

    const url = new URL('wss://api.deepgram.com/v1/speak');
    url.searchParams.set('model', this.model);
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(OUTPUT_SAMPLE_RATE));
    const socket = new WebSocket(url, ['bearer', token]);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = window.setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.close();
        reject(new Error('Streaming speech connection timed out.'));
      }, CONNECT_TIMEOUT_MS);
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        if (error) reject(error);
        else resolve();
      };
      socket.onopen = () => finish();
      socket.onmessage = (event) => this.handleMessage(event);
      socket.onerror = () => finish(new Error('Streaming speech connection failed.'));
      socket.onclose = () => {
        if (this.socket === socket) this.socket = undefined;
        finish(new Error('Streaming speech connection closed.'));
        this.failSpeech(new Error('Streaming speech disconnected.'));
      };
    });
  }

  private handleMessage(event: MessageEvent<unknown>): void {
    if (event.data instanceof ArrayBuffer) {
      this.queuePcm(event.data, this.speech?.version);
      return;
    }
    if (event.data instanceof Blob) {
      const version = this.speech?.version;
      void event.data.arrayBuffer().then((buffer) => this.queuePcm(buffer, version));
      return;
    }
    if (typeof event.data !== 'string') return;
    try {
      const message = JSON.parse(event.data) as { type?: string; description?: string };
      const type = message.type?.toLowerCase();
      if (type === 'flushed' && this.speech) {
        this.speech.flushed = true;
        this.completeSpeechIfReady(this.speech);
      } else if (type === 'error') {
        this.failSpeech(new Error(message.description || 'Streaming speech failed.'));
      }
    } catch {
      // Metadata and forward-compatible control events are not audio failures.
    }
  }

  private queuePcm(buffer: ArrayBuffer, version?: number): void {
    const speech = this.speech;
    const context = this.context;
    const analyser = this.analyser;
    if (!speech || version !== speech.version || !context || !analyser || !buffer.byteLength) return;
    const samples = decodeLinear16(buffer, this.trailingByte);
    this.trailingByte = samples.trailingByte;
    if (!samples.values.length) return;

    const audio = context.createBuffer(1, samples.values.length, OUTPUT_SAMPLE_RATE);
    audio.copyToChannel(samples.values, 0);
    const source = context.createBufferSource();
    source.buffer = audio;
    source.connect(analyser);
    const startAt = Math.max(context.currentTime + 0.012, this.nextStartTime);
    this.nextStartTime = startAt + audio.duration;
    speech.receivedAudio = true;
    speech.pendingSources += 1;
    this.sources.add(source);
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      if (this.speech === speech) {
        speech.pendingSources = Math.max(0, speech.pendingSources - 1);
        this.completeSpeechIfReady(speech);
      }
    };
    source.start(startAt);
  }

  private completeSpeechIfReady(speech: ActiveSpeech): void {
    if (this.speech !== speech || !speech.flushed || speech.pendingSources > 0) return;
    if (!speech.receivedAudio) {
      this.settleSpeech(speech, new Error('Streaming speech returned no audio.'));
      return;
    }
    this.settleSpeech(speech);
  }

  private failSpeech(error: Error, version?: number): void {
    if (!this.speech || (version !== undefined && this.speech.version !== version)) return;
    this.settleSpeech(this.speech, error);
  }

  private settleSpeech(speech: ActiveSpeech, error?: Error): void {
    if (this.speech !== speech) return;
    this.speech = undefined;
    window.clearTimeout(speech.timeout);
    if (speech.signal && speech.onAbort) speech.signal.removeEventListener('abort', speech.onAbort);
    if (error) speech.reject(error);
    else speech.resolve();
  }

  private createAnalyser(context: AudioContext): AnalyserNode {
    const analyser = context.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.56;
    analyser.connect(context.destination);
    return analyser;
  }
}

export function decodeLinear16(
  buffer: ArrayBuffer,
  leadingByte?: number,
): { values: Float32Array<ArrayBuffer>; trailingByte?: number } {
  const incoming = new Uint8Array(buffer);
  const bytes = leadingByte === undefined
    ? incoming
    : Uint8Array.from([leadingByte, ...incoming]);
  const usableLength = bytes.byteLength - (bytes.byteLength % 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, usableLength);
  const values = new Float32Array(usableLength / 2);
  for (let index = 0; index < values.length; index += 1) {
    const sample = view.getInt16(index * 2, true);
    values[index] = sample < 0 ? sample / 32_768 : sample / 32_767;
  }
  return {
    values,
    ...(usableLength < bytes.byteLength ? { trailingByte: bytes[bytes.byteLength - 1] } : {}),
  };
}
