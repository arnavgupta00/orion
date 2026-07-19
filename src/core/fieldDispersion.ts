export interface FieldDispersion {
  shardReach: number;
  cageLocalMultiplier: number;
  worldScales: [number, number, number];
}

/**
 * Keeps an unfolded field outside the camera frustum at every orb zoom level.
 * A small/zoomed-out core receives more local travel so its shards still cross
 * the viewport; a large core carries its scale into the surrounding cages.
 */
export function calculateFieldDispersion(
  presentedScale: number,
  viewportRadius: number,
): FieldDispersion {
  const scale = clamp(presentedScale, 0.03, 1000);
  const radius = clamp(viewportRadius, 0.5, 1000);
  const fieldRadius = Math.max(radius * 1.65, scale * 1.8);

  return {
    shardReach: Math.max(1, (radius * 1.15) / (scale * 1.45)),
    cageLocalMultiplier: Math.max(1, fieldRadius / (scale * 1.28)),
    worldScales: [fieldRadius, fieldRadius * 1.45, fieldRadius * 2.05],
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
