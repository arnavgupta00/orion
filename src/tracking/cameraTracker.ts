import { HandAssociator } from '../core/handAssociator';
import type {
  HandObservation,
  TrackingStats,
  TrackingWorkerResponse,
} from '../core/types';

export interface CameraTrackerCallbacks {
  onHands: (hands: HandObservation[], timestamp: number) => void;
  onStats?: (stats: TrackingStats) => void;
  onError?: (message: string) => void;
}

export class CameraTracker {
  private readonly worker = new Worker(new URL('./hand-worker.ts', import.meta.url), {
    type: 'module',
  });
  private readonly associator = new HandAssociator();
  private stream?: MediaStream;
  private video?: HTMLVideoElement;
  private initialized = false;
  private frameBusy = false;
  private running = false;
  private fallbackFrame?: number;
  private videoFrameCallback?: number;
  private frameTimes: number[] = [];
  private droppedFrames = 0;
  private inferenceMs = 0;
  private delegate: TrackingStats['delegate'] = 'unknown';
  private initialization?: Promise<void>;

  constructor(private readonly callbacks: CameraTrackerCallbacks) {
    this.worker.onmessage = (event: MessageEvent<TrackingWorkerResponse>) => {
      this.handleWorkerMessage(event.data);
    };
    this.worker.onerror = () => {
      this.frameBusy = false;
      this.callbacks.onError?.('The hand-tracking worker stopped unexpectedly. Reload the page to retry.');
    };
  }

  async start(video: HTMLVideoElement, preferredCameraId?: string): Promise<string | undefined> {
    this.video = video;
    this.initialization ??= this.initializeWorker();

    const constraints: MediaTrackConstraints = {
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30, max: 60 },
      ...(preferredCameraId
        ? { deviceId: { exact: preferredCameraId } }
        : { facingMode: { ideal: 'user' } }),
    };

    this.stream = await navigator.mediaDevices.getUserMedia({ video: constraints, audio: false });
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    await this.initialization;

    this.running = true;
    this.scheduleFrame();
    return this.stream.getVideoTracks()[0]?.getSettings().deviceId;
  }

  async listCameras(): Promise<MediaDeviceInfo[]> {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((device) => device.kind === 'videoinput');
  }

  async switchCamera(deviceId: string): Promise<string | undefined> {
    if (!this.video) throw new Error('Start the camera before changing it.');
    const video = this.video;
    this.running = false;
    this.cancelScheduledFrame();
    this.frameBusy = false;
    this.stopStream();
    return this.start(video, deviceId);
  }

  stop(): void {
    this.running = false;
    this.stopStream();
    this.cancelScheduledFrame();
    this.worker.terminate();
    this.associator.reset();
  }

  private initializeWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(
        () => reject(new Error('The hand-tracking model took too long to load.')),
        20_000,
      );
      const listener = (event: MessageEvent<TrackingWorkerResponse>) => {
        if (event.data.type === 'READY') {
          window.clearTimeout(timeout);
          this.worker.removeEventListener('message', listener);
          this.initialized = true;
          this.delegate = event.data.delegate;
          resolve();
        } else if (event.data.type === 'ERROR') {
          window.clearTimeout(timeout);
          this.worker.removeEventListener('message', listener);
          reject(new Error(event.data.message));
        }
      };
      this.worker.addEventListener('message', listener);
      this.worker.postMessage({
        type: 'INIT',
        wasmRoot: '/mediapipe/wasm',
        modelAssetPath: '/models/hand_landmarker.task',
      });
    });
  }

  private scheduleFrame(): void {
    if (!this.running || !this.video) return;
    if (this.video.requestVideoFrameCallback) {
      this.videoFrameCallback = this.video.requestVideoFrameCallback((now) => {
        void this.captureFrame(now);
        this.scheduleFrame();
      });
    } else {
      this.fallbackFrame = requestAnimationFrame((now) => {
        void this.captureFrame(now);
        this.scheduleFrame();
      });
    }
  }

  private async captureFrame(timestamp: number): Promise<void> {
    if (!this.video || !this.initialized || this.video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      return;
    }
    if (this.frameBusy) {
      this.droppedFrames += 1;
      return;
    }

    this.frameBusy = true;
    try {
      const bitmap = await createImageBitmap(this.video);
      this.worker.postMessage({ type: 'DETECT', bitmap, timestamp }, [bitmap]);
    } catch (error) {
      this.frameBusy = false;
      this.callbacks.onError?.(
        error instanceof Error ? error.message : 'The current camera frame could not be read.',
      );
    }
  }

  private handleWorkerMessage(message: TrackingWorkerResponse): void {
    if (message.type === 'READY') {
      this.delegate = message.delegate;
      return;
    }
    if (message.type === 'ERROR') {
      this.frameBusy = false;
      this.callbacks.onError?.(message.message);
      return;
    }

    this.frameBusy = false;
    this.inferenceMs = message.inferenceMs;
    const now = performance.now();
    this.frameTimes.push(now);
    this.frameTimes = this.frameTimes.filter((time) => now - time <= 1000);
    const associated = this.associator.update(
      message.hands,
      message.timestamp,
      message.inferenceMs,
    );
    this.callbacks.onHands(associated, message.timestamp);
    this.callbacks.onStats?.({
      inferenceMs: this.inferenceMs,
      trackingFps: this.frameTimes.length,
      droppedFrames: this.droppedFrames,
      delegate: this.delegate,
    });
  }

  private stopStream(): void {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (this.video) this.video.srcObject = null;
  }

  private cancelScheduledFrame(): void {
    if (this.fallbackFrame !== undefined) {
      cancelAnimationFrame(this.fallbackFrame);
      this.fallbackFrame = undefined;
    }
    if (this.videoFrameCallback !== undefined && this.video?.cancelVideoFrameCallback) {
      this.video.cancelVideoFrameCallback(this.videoFrameCallback);
      this.videoFrameCallback = undefined;
    }
  }
}
