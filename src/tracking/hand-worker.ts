/// <reference lib="webworker" />

import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import type {
  Landmark,
  RawHandObservation,
  TrackingWorkerMessage,
  TrackingWorkerResponse,
} from '../core/types';

const workerScope: DedicatedWorkerGlobalScope = self as unknown as DedicatedWorkerGlobalScope;
let landmarker: HandLandmarker | undefined;

workerScope.onmessage = (event: MessageEvent<TrackingWorkerMessage>) => {
  const message = event.data;
  if (message.type === 'INIT') {
    void initialize(message.wasmRoot, message.modelAssetPath);
    return;
  }

  if (message.type === 'DETECT') detect(message.bitmap, message.timestamp);
};

async function initialize(wasmRoot: string, modelAssetPath: string): Promise<void> {
  try {
    try {
      landmarker = await createLandmarker(
        await createWorkerFileset(wasmRoot),
        modelAssetPath,
        'GPU',
      );
      post({ type: 'READY', delegate: 'GPU' });
    } catch {
      landmarker?.close();
      landmarker = await createLandmarker(
        await createWorkerFileset(wasmRoot),
        modelAssetPath,
        'CPU',
      );
      post({ type: 'READY', delegate: 'CPU' });
    }
  } catch (error) {
    post({
      type: 'ERROR',
      message: error instanceof Error ? error.message : 'Hand tracking could not start.',
    });
  }
}

async function createWorkerFileset(wasmRoot: string) {
  const fileset = await FilesetResolver.forVisionTasks(wasmRoot, true);
  const separator = fileset.wasmLoaderPath.includes('?') ? '&' : '?';
  fileset.wasmLoaderPath = `${fileset.wasmLoaderPath}${separator}worker=${Date.now()}-${Math.random()}`;
  return fileset;
}

function createLandmarker(
  vision: Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>,
  modelAssetPath: string,
  delegate: 'GPU' | 'CPU',
): Promise<HandLandmarker> {
  return HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath,
      delegate,
    },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.48,
    minHandPresenceConfidence: 0.46,
    minTrackingConfidence: 0.46,
  });
}

function detect(bitmap: ImageBitmap, timestamp: number): void {
  if (!landmarker) {
    bitmap.close();
    post({ type: 'ERROR', message: 'Hand tracking is not ready yet.' });
    return;
  }

  const started = performance.now();
  try {
    const result = landmarker.detectForVideo(bitmap, timestamp);
    const hands: RawHandObservation[] = result.landmarks.flatMap((landmarks, index) => {
      const category = result.handednesses[index]?.[0];
      if (!category) return [];
      return [
        {
          handedness: category.categoryName === 'Left' ? 'Left' : 'Right',
          score: category.score,
          landmarks: landmarks.map(copyLandmark),
          worldLandmarks: (result.worldLandmarks[index] ?? []).map(copyLandmark),
        },
      ];
    });
    post({
      type: 'RESULT',
      timestamp,
      inferenceMs: performance.now() - started,
      hands,
    });
  } catch (error) {
    post({
      type: 'ERROR',
      message: error instanceof Error ? error.message : 'A camera frame could not be analyzed.',
    });
  } finally {
    bitmap.close();
  }
}

function copyLandmark(landmark: Landmark): Landmark {
  return {
    x: landmark.x,
    y: landmark.y,
    z: landmark.z,
    ...(landmark.visibility !== undefined ? { visibility: landmark.visibility } : {}),
    ...(landmark.presence !== undefined ? { presence: landmark.presence } : {}),
  };
}

function post(message: TrackingWorkerResponse): void {
  workerScope.postMessage(message);
}
