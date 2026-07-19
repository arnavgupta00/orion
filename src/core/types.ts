export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
}

export type Handedness = 'Left' | 'Right';
export type HandPose = 'neutral' | 'open' | 'fist';

export interface RawHandObservation {
  handedness: Handedness;
  score: number;
  landmarks: Landmark[];
  worldLandmarks: Landmark[];
}

export interface HandObservation extends RawHandObservation {
  id: string;
  timestamp: number;
  inferenceMs: number;
}

export interface CalibrationBounds {
  version: 1;
  left: number;
  right: number;
  top: number;
  bottom: number;
  mirror: true;
  cameraId?: string;
}

export type GestureMode =
  | 'ready'
  | 'awake'
  | 'grab'
  | 'dual'
  | 'release'
  | 'charge'
  | 'burst'
  | 'unfold-armed'
  | 'unfold'
  | 'expanded'
  | 'collapse';

export interface ReticleState {
  handId: string;
  handedness: Handedness;
  x: number;
  y: number;
  pinched: boolean;
  pinchStrength: number;
  pose: HandPose;
  palmX: number;
  palmY: number;
  visibility: number;
}

export interface GestureSnapshot {
  timestamp: number;
  mode: GestureMode;
  reticles: ReticleState[];
  rotationDelta: { x: number; y: number };
  scaleRatio: number;
  rollDelta: number;
  fieldControl: boolean;
  chargeLevel: number;
  intensity: number;
  trackingQuality: number;
}

export interface TrackingStats {
  inferenceMs: number;
  trackingFps: number;
  droppedFrames: number;
  delegate: 'GPU' | 'CPU' | 'unknown';
}

export interface WorkerInitMessage {
  type: 'INIT';
  wasmRoot: string;
  modelAssetPath: string;
}

export interface WorkerDetectMessage {
  type: 'DETECT';
  bitmap: ImageBitmap;
  timestamp: number;
}

export type TrackingWorkerMessage = WorkerInitMessage | WorkerDetectMessage;

export interface WorkerReadyResponse {
  type: 'READY';
  delegate: 'GPU' | 'CPU';
}

export interface WorkerResultResponse {
  type: 'RESULT';
  timestamp: number;
  inferenceMs: number;
  hands: RawHandObservation[];
}

export interface WorkerErrorResponse {
  type: 'ERROR';
  message: string;
}

export type TrackingWorkerResponse =
  | WorkerReadyResponse
  | WorkerResultResponse
  | WorkerErrorResponse;

export function createIdleSnapshot(timestamp = performance.now()): GestureSnapshot {
  return {
    timestamp,
    mode: 'ready',
    reticles: [],
    rotationDelta: { x: 0, y: 0 },
    scaleRatio: 1,
    rollDelta: 0,
    fieldControl: false,
    chargeLevel: 0,
    intensity: 0,
    trackingQuality: 0,
  };
}
