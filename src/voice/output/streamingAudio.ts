/** Streams Orion's speech from the first MP3 bytes and exposes its waveform. */
export class StreamingAudioPlayback {
  private audio?: HTMLAudioElement;
  private objectUrl?: string;
  private settle?: () => void;
  private playbackVersion = 0;
  private context?: AudioContext;
  private source?: MediaElementAudioSourceNode;
  private analyser?: AnalyserNode;
  private fallbackStartedAt = 0;
  private streamReader?: ReadableStreamDefaultReader<Uint8Array>;
  private mediaSource?: MediaSource;
  private sourceBuffer?: SourceBuffer;

  async play(response: Response): Promise<void> {
    this.stop();
    const version = this.playbackVersion;
    const contentType = response.headers.get('Content-Type')?.split(';')[0]?.trim() || 'audio/mpeg';
    if (response.body && typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(contentType)) {
      await this.playStreaming(response.body, contentType, version);
      return;
    }
    const blob = await response.blob();
    if (version !== this.playbackVersion) return;
    if (!blob.size) throw new Error('Speech playback returned no audio.');
    await this.playBuffered(blob);
  }

  async playSystemFallback(text: string): Promise<void> {
    if (!text || !('speechSynthesis' in window)) throw new Error('No fallback speech engine is available.');
    this.stop();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    utterance.rate = 1.02;
    utterance.pitch = 0.86;
    this.fallbackStartedAt = performance.now();
    const voices = window.speechSynthesis.getVoices();
    utterance.voice = voices.find((voice) => voice.lang.toLowerCase() === 'en-us' && /aaron|alex|daniel|google us english/i.test(voice.name))
      ?? voices.find((voice) => voice.lang.toLowerCase().startsWith('en'))
      ?? null;

    await new Promise<void>((resolve, reject) => {
      const settle = () => {
        this.fallbackStartedAt = 0;
        utterance.onend = null;
        utterance.onerror = null;
        if (this.settle === settle) this.settle = undefined;
        resolve();
      };
      this.settle = settle;
      utterance.onend = settle;
      utterance.onerror = () => {
        this.fallbackStartedAt = 0;
        if (this.settle === settle) this.settle = undefined;
        reject(new Error('Fallback speech playback failed.'));
      };
      window.speechSynthesis.speak(utterance);
    });
  }

  stop(): void {
    this.playbackVersion += 1;
    void this.streamReader?.cancel().catch(() => undefined);
    this.streamReader = undefined;
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
      this.audio = undefined;
    }
    this.source?.disconnect();
    this.source = undefined;
    this.analyser?.disconnect();
    this.analyser = undefined;
    this.sourceBuffer = undefined;
    this.mediaSource = undefined;
    this.fallbackStartedAt = 0;
    this.settle?.();
    this.settle = undefined;
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    this.revokeUrl();
  }

  async destroy(): Promise<void> {
    this.stop();
    await this.context?.close();
    this.context = undefined;
  }

  readWaveform(size = 20): number[] {
    if (this.analyser) {
      const data = new Uint8Array(this.analyser.frequencyBinCount);
      this.analyser.getByteFrequencyData(data);
      return Array.from({ length: size }, (_, index) => {
        const sample = data[Math.min(data.length - 1, Math.floor(index * data.length / size))] ?? 0;
        return Math.min(1, sample / 210);
      });
    }
    if (this.fallbackStartedAt) {
      const time = (performance.now() - this.fallbackStartedAt) / 1_000;
      return Array.from({ length: size }, (_, index) => {
        const carrier = Math.abs(Math.sin(time * 9.7 + index * 0.83));
        const syllable = 0.42 + Math.abs(Math.sin(time * 4.1)) * 0.58;
        return 0.08 + carrier * syllable * 0.62;
      });
    }
    return Array.from({ length: size }, () => 0);
  }

  private async playStreaming(
    body: ReadableStream<Uint8Array>,
    contentType: string,
    version: number,
  ): Promise<void> {
    const mediaSource = new MediaSource();
    this.mediaSource = mediaSource;
    const url = URL.createObjectURL(mediaSource);
    this.objectUrl = url;
    const audio = new Audio(url);
    this.audio = audio;
    const { source, analyser } = await this.attachAnalyser(audio);
    const reader = body.getReader();
    this.streamReader = reader;
    let playbackStart: Promise<void> | undefined;
    let playbackEnd: Promise<void> | undefined;

    try {
      await mediaSourceOpen(mediaSource);
      if (version !== this.playbackVersion) return;
      const sourceBuffer = mediaSource.addSourceBuffer(contentType);
      this.sourceBuffer = sourceBuffer;
      if ('mode' in sourceBuffer) sourceBuffer.mode = 'sequence';

      while (true) {
        const { done, value } = await reader.read();
        if (version !== this.playbackVersion) return;
        if (done) break;
        if (!value?.byteLength) continue;
        await appendToSourceBuffer(sourceBuffer, value);
        if (!playbackStart) {
          playbackEnd = this.playbackEnd(audio);
          playbackStart = audio.play();
        }
      }

      if (!playbackStart || !playbackEnd) throw new Error('Speech playback returned no audio.');
      if (sourceBuffer.updating) await sourceBufferUpdate(sourceBuffer);
      if (mediaSource.readyState === 'open') mediaSource.endOfStream();
      await playbackStart;
      await playbackEnd;
    } finally {
      if (this.streamReader === reader) this.streamReader = undefined;
      reader.releaseLock();
      if (this.audio === audio) this.audio = undefined;
      source.disconnect();
      analyser.disconnect();
      if (this.source === source) this.source = undefined;
      if (this.analyser === analyser) this.analyser = undefined;
      if (this.sourceBuffer && mediaSource === this.mediaSource) this.sourceBuffer = undefined;
      if (this.mediaSource === mediaSource) this.mediaSource = undefined;
      this.settle = undefined;
      if (this.objectUrl === url) this.revokeUrl();
      else URL.revokeObjectURL(url);
    }
  }

  private async playBuffered(blob: Blob): Promise<void> {
    const url = URL.createObjectURL(blob);
    this.objectUrl = url;
    const audio = new Audio(url);
    this.audio = audio;
    const { source, analyser } = await this.attachAnalyser(audio);
    try {
      const ended = this.playbackEnd(audio);
      await audio.play();
      await ended;
    } finally {
      if (this.audio === audio) this.audio = undefined;
      source.disconnect();
      analyser.disconnect();
      if (this.source === source) this.source = undefined;
      if (this.analyser === analyser) this.analyser = undefined;
      this.settle = undefined;
      if (this.objectUrl === url) this.revokeUrl();
      else URL.revokeObjectURL(url);
    }
  }

  private async attachAnalyser(audio: HTMLAudioElement): Promise<{
    source: MediaElementAudioSourceNode;
    analyser: AnalyserNode;
  }> {
    this.context ??= new AudioContext({ latencyHint: 'interactive' });
    if (this.context.state === 'suspended') await this.context.resume();
    const analyser = this.context.createAnalyser();
    analyser.fftSize = 64;
    analyser.smoothingTimeConstant = 0.56;
    const source = this.context.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(this.context.destination);
    this.analyser = analyser;
    this.source = source;
    return { source, analyser };
  }

  private playbackEnd(audio: HTMLAudioElement): Promise<void> {
    return new Promise((resolve, reject) => {
      const settle = () => {
        audio.onended = null;
        audio.onerror = null;
        resolve();
      };
      this.settle = settle;
      audio.onended = settle;
      audio.onerror = () => {
        this.settle = undefined;
        reject(new Error('Speech playback failed.'));
      };
    });
  }

  private revokeUrl(): void {
    if (!this.objectUrl) return;
    URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }
}

function mediaSourceOpen(mediaSource: MediaSource): Promise<void> {
  if (mediaSource.readyState === 'open') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      mediaSource.removeEventListener('sourceopen', onOpen);
      mediaSource.removeEventListener('sourceclose', onClose);
    };
    const onOpen = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); reject(new DOMException('Speech stream closed.', 'AbortError')); };
    mediaSource.addEventListener('sourceopen', onOpen, { once: true });
    mediaSource.addEventListener('sourceclose', onClose, { once: true });
  });
}

function appendToSourceBuffer(sourceBuffer: SourceBuffer, chunk: Uint8Array): Promise<void> {
  const copy = new ArrayBuffer(chunk.byteLength);
  new Uint8Array(copy).set(chunk);
  sourceBuffer.appendBuffer(copy);
  return sourceBufferUpdate(sourceBuffer);
}

function sourceBufferUpdate(sourceBuffer: SourceBuffer): Promise<void> {
  if (!sourceBuffer.updating) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      sourceBuffer.removeEventListener('updateend', onEnd);
      sourceBuffer.removeEventListener('error', onError);
      sourceBuffer.removeEventListener('abort', onAbort);
    };
    const onEnd = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new Error('Speech stream could not be buffered.')); };
    const onAbort = () => { cleanup(); reject(new DOMException('Speech stream stopped.', 'AbortError')); };
    sourceBuffer.addEventListener('updateend', onEnd, { once: true });
    sourceBuffer.addEventListener('error', onError, { once: true });
    sourceBuffer.addEventListener('abort', onAbort, { once: true });
  });
}
