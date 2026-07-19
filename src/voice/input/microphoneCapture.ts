/** Captures microphone PCM and flushes the exact audio spoken before release. */
export class MicrophoneCapture {
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private processor?: AudioWorkletNode;
  private analyser?: AnalyserNode;
  private sink?: GainNode;
  private stream?: MediaStream;
  private onChunk?: (chunk: ArrayBuffer) => void;
  private captureGeneration = 0;
  private drainRequestId = 0;
  private pendingDrain?: { requestId: number; resolve: () => void; timeout: number };

  async initialize(): Promise<void> {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: { ideal: 1 },
        sampleRate: { ideal: 48_000 },
      },
      video: false,
    });
    this.stream.getAudioTracks().forEach((track) => { track.enabled = false; });
    this.context = new AudioContext({ latencyHint: 'interactive' });
    await this.context.audioWorklet.addModule('/pcm-worklet.js?v=tail-drain-1');
    this.source = this.context.createMediaStreamSource(this.stream);
    this.processor = new AudioWorkletNode(this.context, 'orion-pcm');
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 64;
    this.analyser.smoothingTimeConstant = 0.7;
    this.sink = this.context.createGain();
    this.sink.gain.value = 0;
    this.processor.port.onmessage = (event: MessageEvent<ArrayBuffer | { type?: string; requestId?: number }>) => {
      if (event.data instanceof ArrayBuffer) {
        this.onChunk?.(event.data);
        return;
      }
      if (event.data.type === 'drained' && event.data.requestId === this.pendingDrain?.requestId) {
        this.finishDrain();
      }
    };
    this.source.connect(this.analyser);
    this.analyser.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.context.destination);
  }

  get sampleRate(): number {
    return this.context?.sampleRate ?? 48_000;
  }

  async start(onChunk: (chunk: ArrayBuffer) => void): Promise<void> {
    if (!this.context || !this.stream || !this.processor) throw new Error('Microphone has not been initialized.');
    this.captureGeneration += 1;
    this.onChunk = onChunk;
    this.stream.getAudioTracks().forEach((track) => { track.enabled = true; });
    this.processor.port.postMessage({ type: 'start' });
    if (this.context.state === 'suspended') await this.context.resume();
  }

  stop(): void {
    this.captureGeneration += 1;
    this.processor?.port.postMessage({ type: 'stop' });
    this.stream?.getAudioTracks().forEach((track) => { track.enabled = false; });
    this.onChunk = undefined;
    this.finishDrain();
  }

  async stopAndFlushCapturedAudio(): Promise<void> {
    if (!this.processor || !this.stream || !this.onChunk) {
      this.stop();
      return;
    }
    const generation = this.captureGeneration;
    const requestId = ++this.drainRequestId;
    await new Promise<void>((resolve) => {
      const timeout = window.setTimeout(() => this.finishDrain(), 250);
      this.pendingDrain = { requestId, resolve, timeout };
      this.processor!.port.postMessage({ type: 'drain', requestId });
    });
    if (generation !== this.captureGeneration) return;
    this.captureGeneration += 1;
    this.stream.getAudioTracks().forEach((track) => { track.enabled = false; });
    this.onChunk = undefined;
  }

  readWaveform(): number[] {
    if (!this.analyser) return Array.from({ length: 24 }, () => 0);
    const data = new Uint8Array(this.analyser.frequencyBinCount);
    this.analyser.getByteFrequencyData(data);
    return Array.from({ length: 24 }, (_, index) => {
      const sample = data[Math.min(data.length - 1, Math.floor(index * data.length / 24))] ?? 0;
      return sample / 255;
    });
  }

  readInputLevel(): { rms: number; clipping: boolean } {
    if (!this.analyser) return { rms: 0, clipping: false };
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let squareSum = 0;
    let peak = 0;
    for (const sample of data) {
      squareSum += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    return { rms: Math.sqrt(squareSum / Math.max(1, data.length)), clipping: peak >= 0.985 };
  }

  async destroy(): Promise<void> {
    this.stop();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.source?.disconnect();
    this.processor?.disconnect();
    this.analyser?.disconnect();
    this.sink?.disconnect();
    await this.context?.close();
    this.stream = undefined;
  }

  private finishDrain(): void {
    if (!this.pendingDrain) return;
    window.clearTimeout(this.pendingDrain.timeout);
    const resolve = this.pendingDrain.resolve;
    this.pendingDrain = undefined;
    resolve();
  }
}
