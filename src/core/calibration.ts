import type { CalibrationBounds } from './types';

const STORAGE_KEY = 'solar-core.calibration.v1';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DEFAULT_CALIBRATION: CalibrationBounds = {
  version: 1,
  left: 0.14,
  right: 0.86,
  top: 0.12,
  bottom: 0.84,
  mirror: true,
};

export function isValidCalibration(value: unknown): value is CalibrationBounds {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CalibrationBounds>;
  return (
    candidate.version === 1 &&
    candidate.mirror === true &&
    [candidate.left, candidate.right, candidate.top, candidate.bottom].every(
      (entry) => typeof entry === 'number' && Number.isFinite(entry),
    ) &&
    candidate.left! >= 0 &&
    candidate.right! <= 1 &&
    candidate.top! >= 0 &&
    candidate.bottom! <= 1 &&
    candidate.right! - candidate.left! >= 0.3 &&
    candidate.bottom! - candidate.top! >= 0.3
  );
}

export class CalibrationStore {
  constructor(private readonly storage: StorageLike) {}

  load(): CalibrationBounds | null {
    try {
      const raw = this.storage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (!isValidCalibration(parsed)) {
        this.clear();
        return null;
      }
      return parsed;
    } catch {
      this.clear();
      return null;
    }
  }

  save(bounds: CalibrationBounds): void {
    if (!isValidCalibration(bounds)) {
      throw new Error('Calibration bounds are not usable.');
    }
    this.storage.setItem(STORAGE_KEY, JSON.stringify(bounds));
  }

  clear(): void {
    this.storage.removeItem(STORAGE_KEY);
  }
}

export function createCalibrationFromPoints(
  points: Array<{ x: number; y: number }>,
  cameraId?: string,
): CalibrationBounds {
  if (points.length !== 4) {
    throw new Error('Calibration requires four captured points.');
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const bounds: CalibrationBounds = {
    version: 1,
    left: Math.max(0, Math.min(...xs)),
    right: Math.min(1, Math.max(...xs)),
    top: Math.max(0, Math.min(...ys)),
    bottom: Math.min(1, Math.max(...ys)),
    mirror: true,
    ...(cameraId ? { cameraId } : {}),
  };

  if (!isValidCalibration(bounds)) {
    throw new Error('Move farther between calibration targets and try again.');
  }
  return bounds;
}

export function mapCameraPoint(
  x: number,
  y: number,
  bounds: CalibrationBounds,
): { x: number; y: number } {
  const mirroredX = bounds.mirror ? 1 - x : x;
  return {
    x: clamp01((mirroredX - bounds.left) / (bounds.right - bounds.left)),
    y: clamp01((y - bounds.top) / (bounds.bottom - bounds.top)),
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
