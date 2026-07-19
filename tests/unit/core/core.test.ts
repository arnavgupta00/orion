import { describe, expect, it } from 'vitest';
import {
  CalibrationStore,
  DEFAULT_CALIBRATION,
  createCalibrationFromPoints,
  mapCameraPoint,
  type StorageLike,
} from '../../../src/core/calibration';
import { calculateFieldDispersion } from '../../../src/core/fieldDispersion';
import { GestureEngine, classifyHandPose, pinchRatio } from '../../../src/core/gestureEngine';
import { HandAssociator } from '../../../src/core/handAssociator';
import { accumulateZoomLog, presentZoom } from '../../../src/core/infiniteZoom';
import { OneEuroFilter } from '../../../src/core/oneEuro';
import type { HandObservation, Handedness, Landmark, RawHandObservation } from '../../../src/core/types';

describe('calibration', () => {
  it('mirrors and maps camera coordinates into the calibrated screen range', () => {
    expect(mapCameraPoint(0.86, 0.12, DEFAULT_CALIBRATION)).toEqual({ x: 0, y: 0 });
    expect(mapCameraPoint(0.14, 0.84, DEFAULT_CALIBRATION)).toEqual({ x: 1, y: 1 });
    expect(mapCameraPoint(0.5, 0.48, DEFAULT_CALIBRATION)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('builds valid bounds from four points and rejects cramped calibration', () => {
    const bounds = createCalibrationFromPoints([
      { x: 0.18, y: 0.2 },
      { x: 0.82, y: 0.2 },
      { x: 0.82, y: 0.8 },
      { x: 0.18, y: 0.8 },
    ]);
    expect(bounds).toMatchObject({ left: 0.18, right: 0.82, top: 0.2, bottom: 0.8 });
    expect(() =>
      createCalibrationFromPoints([
        { x: 0.4, y: 0.4 },
        { x: 0.55, y: 0.4 },
        { x: 0.55, y: 0.55 },
        { x: 0.4, y: 0.55 },
      ]),
    ).toThrow(/farther/);
  });

  it('clears corrupted stored calibration', () => {
    const storage = new MemoryStorage();
    storage.setItem('solar-core.calibration.v1', '{broken');
    const store = new CalibrationStore(storage);
    expect(store.load()).toBeNull();
    expect(storage.getItem('solar-core.calibration.v1')).toBeNull();
  });
});

describe('tracking primitives', () => {
  it('normalizes pinch distance by palm width', () => {
    expect(pinchRatio(makeLandmarks(0.5, 0.5, true))).toBeLessThan(0.46);
    expect(pinchRatio(makeLandmarks(0.5, 0.5, false))).toBeGreaterThan(0.62);
  });

  it('accepts a natural near-pinch while rejecting a clearly open hand', () => {
    const nearPinch = makeLandmarks(0.5, 0.5, false);
    nearPinch[8] = { x: 0.5, y: 0.5, z: 0 };
    nearPinch[4] = { x: 0.575, y: 0.5, z: 0.018 };
    expect(pinchRatio(nearPinch)).toBeLessThan(0.46);

    const open = makeLandmarks(0.5, 0.5, false);
    expect(pinchRatio(open)).toBeGreaterThan(0.62);
  });

  it('separates open palms, fists, and neutral hands', () => {
    expect(classifyHandPose(makeLandmarks(0.5, 0.5, false, 'open'))).toBe('open');
    expect(classifyHandPose(makeLandmarks(0.5, 0.5, false, 'fist'))).toBe('fist');
    expect(classifyHandPose(makeLandmarks(0.5, 0.5, false, 'neutral'))).toBe('neutral');
  });

  it('does not mistake a compact-finger pinch for a fist', () => {
    const curledPinch = makeLandmarks(0.5, 0.5, false, 'fist');
    curledPinch[8] = { x: 0.5, y: 0.48, z: 0 };
    curledPinch[4] = { x: 0.535, y: 0.48, z: 0 };
    expect(pinchRatio(curledPinch)).toBeLessThan(0.46);
    expect(classifyHandPose(curledPinch)).toBe('neutral');
  });

  it('keeps a stable hand id across nearby frames', () => {
    const associator = new HandAssociator();
    const first = associator.update([makeRawHand(0.55, 0.5, false)], 0, 8);
    const second = associator.update([makeRawHand(0.57, 0.49, false)], 33, 7);
    expect(first[0]?.id).toBe(second[0]?.id);
  });

  it('smooths noisy coordinates without producing invalid values', () => {
    const filter = new OneEuroFilter();
    const samples = [0.5, 0.62, 0.48, 0.57, 0.51].map((value, index) =>
      filter.filter(value, index * 33),
    );
    expect(samples.every(Number.isFinite)).toBe(true);
    expect(samples.at(-1)).toBeGreaterThan(0.48);
    expect(samples.at(-1)).toBeLessThan(0.58);
  });
});

describe('gesture state machine', () => {
  const viewport = () => ({ width: 1470, height: 956 });

  it('moves from awake to grab and safely releases', () => {
    const engine = new GestureEngine(DEFAULT_CALIBRATION, viewport);
    expect(engine.update([makeHand('one', 0.5, 0.5, false, 0)], 0).mode).toBe('awake');
    engine.update([makeHand('one', 0.5, 0.5, true, 33)], 33);
    expect(engine.update([makeHand('one', 0.5, 0.5, true, 66)], 66).mode).toBe('grab');
    engine.update([makeHand('one', 0.5, 0.5, false, 99)], 99);
    expect(engine.update([makeHand('one', 0.5, 0.5, false, 132)], 132).mode).toBe('release');
    expect(engine.update([], 500).mode).toBe('ready');
  });

  it('engages dual control without capping outward scale', () => {
    const engine = new GestureEngine(DEFAULT_CALIBRATION, viewport);
    const pinchedPair = (leftX: number, rightX: number, timestamp: number) => [
      makeHand('left', leftX, 0.5, true, timestamp, 'Left'),
      makeHand('right', rightX, 0.5, true, timestamp, 'Right'),
    ];
    engine.update(pinchedPair(0.64, 0.36, 0), 0);
    expect(engine.update(pinchedPair(0.64, 0.36, 33), 33).mode).toBe('dual');
    let expanded = engine.update(pinchedPair(0.86, 0.14, 66), 66);
    for (let frame = 3; frame < 24; frame += 1) {
      expanded = engine.update(pinchedPair(0.86, 0.14, frame * 33), frame * 33);
    }
    expect(expanded.mode).toBe('dual');
    expect(expanded.scaleRatio).toBeGreaterThan(2);
  });

  it('forces release when a grabbed hand is lost', () => {
    const engine = new GestureEngine(DEFAULT_CALIBRATION, viewport);
    engine.update([makeHand('one', 0.5, 0.5, true, 0)], 0);
    expect(engine.update([makeHand('one', 0.5, 0.5, true, 33)], 33).mode).toBe('grab');
    expect(engine.update([], 320).mode).toBe('release');
    expect(engine.update([], 700).mode).toBe('ready');
  });

  it('charges with a fist and disperses when that hand opens rapidly', () => {
    const engine = new GestureEngine(DEFAULT_CALIBRATION, viewport);
    engine.update([makeHand('one', 0.5, 0.45, false, 0, 'Right', 'fist')], 0);
    expect(engine.update([makeHand('one', 0.5, 0.45, false, 33, 'Right', 'fist')], 33).mode)
      .toBe('charge');
    const charged = engine.update(
      [makeHand('one', 0.5, 0.45, false, 420, 'Right', 'fist')],
      420,
    );
    expect(charged.chargeLevel).toBeGreaterThan(0.35);
    engine.update([makeHand('one', 0.5, 0.45, false, 453, 'Right', 'open')], 453);
    expect(engine.update([makeHand('one', 0.5, 0.45, false, 486, 'Right', 'open')], 486).mode)
      .toBe('burst');
  });

  it('arms two open palms, unfolds on a rapid spread, and collapses with two fists', () => {
    const engine = new GestureEngine(DEFAULT_CALIBRATION, viewport);
    const pair = (
      leftX: number,
      rightX: number,
      timestamp: number,
      pose: TestPose,
    ) => [
      makeHand('left', leftX, 0.43, false, timestamp, 'Left', pose),
      makeHand('right', rightX, 0.43, false, timestamp, 'Right', pose),
    ];

    engine.update(pair(0.64, 0.36, 0, 'open'), 0);
    engine.update(pair(0.64, 0.36, 33, 'open'), 33);
    expect(engine.update(pair(0.64, 0.36, 330, 'open'), 330).mode).toBe('unfold-armed');
    let unfolding = engine.update(pair(0.84, 0.16, 363, 'open'), 363);
    if (unfolding.mode !== 'unfold') {
      unfolding = engine.update(pair(0.86, 0.14, 396, 'open'), 396);
    }
    expect(unfolding.mode).toBe('unfold');
    expect(engine.update(pair(0.86, 0.14, 1500, 'open'), 1500).mode).toBe('expanded');

    const fieldPair = (leftX: number, rightX: number, rawY: number, timestamp: number) => [
      makeHand('left', leftX, rawY, true, timestamp, 'Left'),
      makeHand('right', rightX, rawY, true, timestamp, 'Right'),
    ];
    engine.update(fieldPair(0.64, 0.36, 0.43, 1533), 1533);
    const fieldStart = engine.update(fieldPair(0.64, 0.36, 0.43, 1566), 1566);
    expect(fieldStart.fieldControl).toBe(true);
    const fieldMove = engine.update(fieldPair(0.84, 0.16, 0.35, 1599), 1599);
    expect(fieldMove.fieldControl).toBe(true);
    expect(fieldMove.scaleRatio).toBeGreaterThan(1);
    expect(Math.abs(fieldMove.rotationDelta.x)).toBeGreaterThan(0);

    engine.update(pair(0.72, 0.28, 1632, 'open'), 1632);
    engine.update(pair(0.72, 0.28, 1665, 'open'), 1665);
    engine.update(pair(0.72, 0.28, 1700, 'fist'), 1700);
    engine.update(pair(0.72, 0.28, 1733, 'fist'), 1733);
    expect(engine.update(pair(0.72, 0.28, 2040, 'fist'), 2040).mode).toBe('collapse');
    engine.update(pair(0.72, 0.28, 3000, 'fist'), 3000);
    expect(engine.update(pair(0.72, 0.28, 3300, 'fist'), 3300).mode).not.toBe('charge');
  });
});

describe('field dispersion', () => {
  it('compensates for zoomed-out cores and always crosses the viewport', () => {
    const viewportRadius = 3.2;
    const normal = calculateFieldDispersion(1.12, viewportRadius);
    const zoomedOut = calculateFieldDispersion(0.1, viewportRadius);
    expect(zoomedOut.shardReach).toBeGreaterThan(normal.shardReach * 8);
    expect(zoomedOut.cageLocalMultiplier).toBeGreaterThan(normal.cageLocalMultiplier * 8);
    expect(normal.worldScales[0]).toBeGreaterThan(viewportRadius * 1.6);
    expect(zoomedOut.worldScales[2]).toBeGreaterThan(viewportRadius * 3);
  });
});

describe('infinite zoom', () => {
  it('accumulates repeated two-hand spreads without an absolute scale cap', () => {
    let zoomLog = 0;
    for (let gesture = 0; gesture < 100; gesture += 1) {
      zoomLog = accumulateZoomLog(zoomLog, 1.8);
    }
    expect(zoomLog).toBeGreaterThan(50);
    expect(Number.isFinite(zoomLog)).toBe(true);
  });

  it('keeps accumulating zoom-out below the resting size', () => {
    expect(accumulateZoomLog(2.4, 0.5)).toBeLessThan(2.4);
    expect(accumulateZoomLog(0.2, 0.04)).toBeLessThan(0);
    let zoomLog = 0;
    for (let gesture = 0; gesture < 100; gesture += 1) {
      zoomLog = accumulateZoomLog(zoomLog, 0.55);
    }
    expect(zoomLog).toBeLessThan(-50);
    expect(Number.isFinite(zoomLog)).toBe(true);
  });

  it('turns very large zoom values into stable repeating interior travel', () => {
    const near = presentZoom(0);
    const source = presentZoom(Math.log(8));
    const deep = presentZoom(80);
    expect(near.shellDissolve).toBe(0);
    expect(near.sourceFocus).toBe(0);
    expect(near.sourceApproach).toBe(0);
    expect(near.immersion).toBe(0);
    expect(source.shellDissolve).toBe(1);
    expect(source.sourceFocus).toBeGreaterThan(0.95);
    expect(source.sourceApproach).toBeGreaterThan(0);
    expect(source.immersion).toBe(0);
    expect(deep.sourceFocus).toBe(0);
    expect(deep.immersion).toBe(1);
    expect(deep.surfaceScale).toBeLessThan(12);
    expect(deep.travel).toBeGreaterThan(70);
  });
});

function makeHand(
  id: string,
  rawX: number,
  rawY: number,
  pinched: boolean,
  timestamp: number,
  handedness: Handedness = 'Right',
  pose: TestPose = 'neutral',
): HandObservation {
  return {
    id,
    timestamp,
    inferenceMs: 8,
    handedness,
    score: 0.98,
    landmarks: makeLandmarks(rawX, rawY, pinched, pose),
    worldLandmarks: [],
  };
}

function makeRawHand(rawX: number, rawY: number, pinched: boolean): RawHandObservation {
  return {
    handedness: 'Right',
    score: 0.98,
    landmarks: makeLandmarks(rawX, rawY, pinched),
    worldLandmarks: [],
  };
}

type TestPose = 'neutral' | 'open' | 'fist';

function makeLandmarks(
  rawX: number,
  rawY: number,
  pinched: boolean,
  pose: TestPose = 'neutral',
): Landmark[] {
  const landmarks = Array.from({ length: 21 }, () => ({ x: rawX, y: rawY, z: 0 }));
  landmarks[0] = { x: rawX, y: rawY + 0.18, z: 0 };
  landmarks[5] = { x: rawX - 0.09, y: rawY + 0.08, z: 0 };
  landmarks[9] = { x: rawX - 0.03, y: rawY + 0.075, z: 0 };
  landmarks[13] = { x: rawX + 0.035, y: rawY + 0.078, z: 0 };
  landmarks[17] = { x: rawX + 0.09, y: rawY + 0.08, z: 0 };
  const fingers = [
    { tip: 8, pip: 6, x: 0 },
    { tip: 12, pip: 10, x: -0.03 },
    { tip: 16, pip: 14, x: 0.035 },
    { tip: 20, pip: 18, x: 0.09 },
  ];
  fingers.forEach((finger, index) => {
    landmarks[finger.pip] = { x: rawX + finger.x, y: rawY + 0.005, z: 0 };
    const extended = pose === 'open' || (pose === 'neutral' && index < 2);
    landmarks[finger.tip] = {
      x: rawX + finger.x,
      y: extended ? rawY - 0.11 : rawY + 0.09,
      z: 0,
    };
  });
  if (pinched) landmarks[8] = { x: rawX, y: rawY, z: 0 };
  landmarks[4] = pose === 'fist'
    ? { x: rawX + 0.1, y: rawY + 0.02, z: 0 }
    : { x: rawX + (pinched ? 0.035 : 0.14), y: rawY, z: 0 };
  return landmarks;
}

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}
