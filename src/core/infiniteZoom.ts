export interface ZoomPresentation {
  surfaceScale: number;
  shellDissolve: number;
  sourceFocus: number;
  sourceApproach: number;
  immersion: number;
  travel: number;
}

const MIN_GESTURE_RATIO = 0.04;
const SURFACE_SCALE_MIN_LOG = -2.4;
const SURFACE_SCALE_MAX_LOG = 2.48;

/**
 * Zoom is stored in logarithmic space, so repeated two-hand gestures can keep
 * accumulating without hitting a scene-scale ceiling or overflowing a number.
 */
export function accumulateZoomLog(baseLog: number, gestureRatio: number): number {
  if (!Number.isFinite(baseLog) || !Number.isFinite(gestureRatio)) return baseLog;
  return baseLog + Math.log(Math.max(gestureRatio, MIN_GESTURE_RATIO));
}

/**
 * Zoom crosses three readable layers: the faceted shell, its internal light,
 * and finally the procedural interior that can repeat forever without clipping.
 */
export function presentZoom(zoomLog: number): ZoomPresentation {
  const safeLog = Number.isFinite(zoomLog) ? zoomLog : 0;
  return {
    surfaceScale: Math.exp(clamp(safeLog, SURFACE_SCALE_MIN_LOG, SURFACE_SCALE_MAX_LOG)),
    shellDissolve: smoothstep(1.38, 1.98, safeLog),
    sourceFocus:
      smoothstep(1.5, 2.15, safeLog) *
      (1 - smoothstep(3.15, 3.65, safeLog)),
    sourceApproach: smoothstep(1.45, 3.3, safeLog),
    immersion: smoothstep(3.15, 3.85, safeLog),
    travel: Math.max(0, safeLog - 3.1),
  };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const normalized = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
