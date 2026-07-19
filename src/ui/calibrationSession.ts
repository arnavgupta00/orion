import { createCalibrationFromPoints } from '../core/calibration';
import {
  PINCH_ENGAGE_RATIO,
  PINCH_RELEASE_RATIO,
  pinchPoint,
  pinchRatio,
} from '../core/gestureEngine';
import type { CalibrationBounds, HandObservation } from '../core/types';

export const CALIBRATION_TARGETS = [
  { x: 0.18, y: 0.2, label: 'upper-left' },
  { x: 0.82, y: 0.2, label: 'upper-right' },
  { x: 0.82, y: 0.8, label: 'lower-right' },
  { x: 0.18, y: 0.8, label: 'lower-left' },
] as const;

export interface CalibrationProgress {
  currentIndex: number;
  target: (typeof CALIBRATION_TARGETS)[number] | null;
  reticle: { x: number; y: number; pinched: boolean } | null;
  completed: boolean;
}

export class CalibrationSession {
  private readonly points: Array<{ x: number; y: number }> = [];
  private armed = true;
  private pinchFrames = 0;
  private releaseFrames = 0;

  constructor(private readonly cameraId?: string) {}

  update(hands: HandObservation[]): CalibrationProgress {
    const hand = hands[0];
    if (!hand) return this.progress(null);

    const ratio = pinchRatio(hand.landmarks);
    const pointer = pinchPoint(hand.landmarks, ratio);
    if (!pointer) return this.progress(null);
    const point = { x: 1 - pointer.x, y: pointer.y };
    const pinched = ratio < PINCH_ENGAGE_RATIO;
    const released = ratio > PINCH_RELEASE_RATIO;

    this.pinchFrames = pinched ? this.pinchFrames + 1 : 0;
    this.releaseFrames = released ? this.releaseFrames + 1 : 0;
    if (this.releaseFrames >= 2) this.armed = true;

    const target = CALIBRATION_TARGETS[this.points.length];
    if (
      target &&
      this.armed &&
      this.pinchFrames >= 2 &&
      Math.hypot(point.x - target.x, point.y - target.y) <= 0.17
    ) {
      this.points.push(point);
      this.armed = false;
      this.pinchFrames = 0;
    }

    return this.progress({ ...point, pinched });
  }

  getBounds(): CalibrationBounds {
    return createCalibrationFromPoints(this.points, this.cameraId);
  }

  private progress(
    reticle: CalibrationProgress['reticle'],
  ): CalibrationProgress {
    return {
      currentIndex: this.points.length,
      target: CALIBRATION_TARGETS[this.points.length] ?? null,
      reticle,
      completed: this.points.length === CALIBRATION_TARGETS.length,
    };
  }
}
