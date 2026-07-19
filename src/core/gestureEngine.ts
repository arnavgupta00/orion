import { mapCameraPoint } from './calibration';
import { OneEuroFilter } from './oneEuro';
import type {
  CalibrationBounds,
  GestureMode,
  GestureSnapshot,
  HandObservation,
  HandPose,
  Landmark,
  ReticleState,
} from './types';

interface HandRuntime {
  id: string;
  handedness: HandObservation['handedness'];
  xFilter: OneEuroFilter;
  yFilter: OneEuroFilter;
  palmXFilter: OneEuroFilter;
  palmYFilter: OneEuroFilter;
  x: number;
  y: number;
  palmX: number;
  palmY: number;
  pinched: boolean;
  candidatePinched: boolean;
  candidateFrames: number;
  justPinched: boolean;
  pinchStrength: number;
  pose: HandPose;
  candidatePose: HandPose;
  candidatePoseFrames: number;
  score: number;
  lastSeen: number;
}

interface DualAnchor {
  distance: number;
  angle: number;
  midpoint: { x: number; y: number };
}

interface ChargeState {
  handId: string;
  startedAt: number;
  lastFistAt: number;
  level: number;
}

interface UnfoldState {
  seenAt: number;
  armed: boolean;
  anchorDistance: number;
  previousDistance: number;
  previousAt: number;
  lastOpenAt: number;
}

// MediaPipe fingertips rarely resolve as perfectly touching on a laptop webcam.
// These thresholds intentionally leave a wide hysteresis band so a real pinch
// engages easily without chattering open while the hand is moving.
export const PINCH_ENGAGE_RATIO = 0.46;
export const PINCH_RELEASE_RATIO = 0.62;

const PINCH_MIN_RATIO = 0.18;
const CHARGE_FULL_MS = 900;
const CHARGE_RELEASE_GRACE_MS = 380;
const BURST_DURATION_MS = 720;
const UNFOLD_HOLD_MS = 280;
const UNFOLD_SPREAD_DISTANCE = 0.16;
const UNFOLD_SPREAD_SPEED = 0.36;
const UNFOLD_DURATION_MS = 1050;
const COLLAPSE_HOLD_MS = 280;
const COLLAPSE_DURATION_MS = 850;

const FINGERS = [
  { tip: 8, pip: 6 },
  { tip: 12, pip: 10 },
  { tip: 16, pip: 14 },
  { tip: 20, pip: 18 },
] as const;

export function pinchRatio(landmarks: Landmark[]): number {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  const indexMcp = landmarks[5];
  const middleMcp = landmarks[9];
  const pinkyMcp = landmarks[17];
  const wrist = landmarks[0];
  if (!thumbTip || !indexTip || !indexMcp || !middleMcp || !pinkyMcp || !wrist) {
    return Number.POSITIVE_INFINITY;
  }

  const pinchDistance = landmarkDistance(thumbTip, indexTip, 0.32);
  const palmWidth = landmarkDistance(indexMcp, pinkyMcp, 0.18);
  const palmLength = landmarkDistance(wrist, middleMcp, 0.18);
  const handScale = Math.max(palmWidth, palmLength * 0.78);
  return handScale > 0.001 ? pinchDistance / handScale : Number.POSITIVE_INFINITY;
}

export function pinchPoint(landmarks: Landmark[], ratio = pinchRatio(landmarks)): Landmark | null {
  const thumbTip = landmarks[4];
  const indexTip = landmarks[8];
  if (!thumbTip || !indexTip) return null;

  const strength = pinchStrength(ratio);
  const midpoint = {
    x: (thumbTip.x + indexTip.x) / 2,
    y: (thumbTip.y + indexTip.y) / 2,
    z: (thumbTip.z + indexTip.z) / 2,
  };
  return {
    x: lerp(indexTip.x, midpoint.x, strength),
    y: lerp(indexTip.y, midpoint.y, strength),
    z: lerp(indexTip.z, midpoint.z, strength),
  };
}

export function classifyHandPose(landmarks: Landmark[]): HandPose {
  const wrist = landmarks[0];
  const middleMcp = landmarks[9];
  const indexMcp = landmarks[5];
  const pinkyMcp = landmarks[17];
  if (!wrist || !middleMcp || !indexMcp || !pinkyMcp) return 'neutral';

  const palmScale = Math.max(
    landmarkDistance(wrist, middleMcp, 0.12),
    landmarkDistance(indexMcp, pinkyMcp, 0.12) * 0.82,
  );
  if (palmScale < 0.001) return 'neutral';

  let extended = 0;
  let curled = 0;
  for (const finger of FINGERS) {
    const tip = landmarks[finger.tip];
    const pip = landmarks[finger.pip];
    if (!tip || !pip) continue;
    const extension =
      (landmarkDistance(wrist, tip, 0.12) - landmarkDistance(wrist, pip, 0.12)) /
      palmScale;
    if (extension > 0.2) extended += 1;
    if (extension < 0.055) curled += 1;
  }

  if (extended >= 3) return 'open';
  if (extended === 0 && curled >= 3) {
    const thumbTip = landmarks[4];
    const indexTip = landmarks[8];
    const palm = palmPoint(landmarks);
    if (thumbTip && indexTip && palm) {
      const gripCenter = {
        x: (thumbTip.x + indexTip.x) / 2,
        y: (thumbTip.y + indexTip.y) / 2,
        z: (thumbTip.z + indexTip.z) / 2,
      };
      if (landmarkDistance(gripCenter, palm, 0.12) / palmScale < 0.72) return 'fist';
    }
  }
  return 'neutral';
}

export class GestureEngine {
  private readonly hands = new Map<string, HandRuntime>();
  private mode: GestureMode = 'ready';
  private activeGrabId?: string;
  private grabPrevious?: { x: number; y: number };
  private dualAnchor?: DualAnchor;
  private dualLocked = false;
  private releaseUntil = 0;
  private actionUntil = 0;
  private charge?: ChargeState;
  private unfold?: UnfoldState;
  private expanded = false;
  private collapseSeenAt = 0;
  private timestamp = 0;
  private poseLocked = false;
  private fieldDualAnchor?: DualAnchor;
  private fieldDualLocked = false;
  private fieldControl = false;

  constructor(
    private calibration: CalibrationBounds,
    private readonly viewport: () => { width: number; height: number },
  ) {}

  setCalibration(calibration: CalibrationBounds): void {
    this.calibration = calibration;
    this.reset();
  }

  setFieldState(expanded: boolean): void {
    this.expanded = expanded;
    this.mode = expanded ? 'expanded' : 'ready';
    this.unfold = undefined;
    this.fieldDualAnchor = undefined;
    this.fieldDualLocked = false;
    this.fieldControl = false;
    this.collapseSeenAt = 0;
  }

  update(observations: HandObservation[], timestamp: number): GestureSnapshot {
    this.timestamp = timestamp;
    const seen = new Set<string>();
    for (const observation of observations) {
      seen.add(observation.id);
      this.updateHand(observation, timestamp);
    }

    for (const [id, hand] of this.hands) {
      hand.justPinched = seen.has(id) ? hand.justPinched : false;
      if (timestamp - hand.lastSeen > 250) this.hands.delete(id);
    }

    const reticles = this.createReticles(timestamp);
    const actionable = reticles.filter((reticle) => reticle.visibility > 0.6);
    const pinched = actionable.filter((reticle) => reticle.pinched);
    const allOpen = actionable.length === 0 || actionable.every((reticle) => !reticle.pinched);
    if (this.dualLocked && allOpen) this.dualLocked = false;
    if (this.fieldDualLocked && allOpen) this.fieldDualLocked = false;
    if (this.poseLocked && actionable.every((reticle) => reticle.pose !== 'fist')) {
      this.poseLocked = false;
    }

    let rotationDelta = { x: 0, y: 0 };
    let scaleRatio = 1;
    let rollDelta = 0;

    if (this.mode === 'burst') {
      if (timestamp < this.actionUntil) {
        return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
      }
      this.mode = actionable.length ? 'awake' : 'ready';
    }

    if (this.mode === 'unfold') {
      if (timestamp < this.actionUntil) {
        return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
      }
      this.mode = 'expanded';
    }

    if (this.mode === 'collapse') {
      if (timestamp < this.actionUntil) {
        return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
      }
      this.expanded = false;
      this.mode = 'release';
      this.releaseUntil = timestamp + 240;
      this.collapseSeenAt = 0;
    }

    if (this.expanded) {
      const fists = actionable.filter((reticle) => reticle.pose === 'fist');
      if (fists.length >= 2) {
        this.fieldDualAnchor = undefined;
        this.fieldControl = false;
        if (!this.collapseSeenAt) this.collapseSeenAt = timestamp;
        if (timestamp - this.collapseSeenAt >= COLLAPSE_HOLD_MS) {
          this.mode = 'collapse';
          this.actionUntil = timestamp + COLLAPSE_DURATION_MS;
          this.poseLocked = true;
        } else {
          this.mode = 'expanded';
        }
      } else {
        this.collapseSeenAt = 0;
        this.mode = 'expanded';
      }

      if (this.mode === 'collapse') {
        return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
      }

      if (pinched.length >= 2 && !this.fieldDualLocked) {
        const current = dualMetrics(pinched[0]!, pinched[1]!);
        if (!this.fieldDualAnchor) this.fieldDualAnchor = current;
        else {
          scaleRatio = Math.max(current.distance / this.fieldDualAnchor.distance, 0.04);
          rollDelta = normalizeAngle(current.angle - this.fieldDualAnchor.angle);
          rotationDelta = {
            x: (current.midpoint.y - this.fieldDualAnchor.midpoint.y) * 1.6,
            y: (current.midpoint.x - this.fieldDualAnchor.midpoint.x) * 1.6,
          };
        }
        this.fieldControl = true;
      } else {
        if (this.fieldDualAnchor && pinched.length < 2) this.fieldDualLocked = true;
        this.fieldDualAnchor = undefined;
        this.fieldControl = false;
      }
      return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
    }

    this.fieldControl = false;

    if (this.mode === 'charge' && this.charge) {
      const hand = actionable.find((reticle) => reticle.handId === this.charge?.handId);
      if (hand?.pose === 'fist') {
        this.charge.lastFistAt = timestamp;
        this.charge.level = clamp((timestamp - this.charge.startedAt) / CHARGE_FULL_MS, 0, 1);
      } else if (
        hand?.pose === 'open' &&
        this.charge.level >= 0.24 &&
        timestamp - this.charge.lastFistAt <= CHARGE_RELEASE_GRACE_MS
      ) {
        this.mode = 'burst';
        this.actionUntil = timestamp + BURST_DURATION_MS;
        this.charge = undefined;
      } else if (timestamp - this.charge.lastFistAt > CHARGE_RELEASE_GRACE_MS) {
        this.charge = undefined;
        this.mode = actionable.length ? 'awake' : 'ready';
      }

      if (this.mode === 'charge' || this.mode === 'burst') {
        return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
      }
    }

    if (this.mode === 'dual') {
      if (pinched.length < 2 || !this.dualAnchor) {
        this.enterRelease(timestamp, true);
      } else {
        const first = pinched[0]!;
        const second = pinched[1]!;
        const current = dualMetrics(first, second);
        // The scene accumulates this ratio in logarithmic space. Keep it
        // uncapped here so spreading the hands never hits an artificial wall.
        scaleRatio = Math.max(current.distance / this.dualAnchor.distance, 0.04);
        rollDelta = normalizeAngle(current.angle - this.dualAnchor.angle);
        rotationDelta = {
          x: (current.midpoint.y - this.dualAnchor.midpoint.y) * 1.6,
          y: (current.midpoint.x - this.dualAnchor.midpoint.x) * 1.6,
        };
      }
    }

    if (this.mode === 'grab') {
      const active = actionable.find((reticle) => reticle.handId === this.activeGrabId);
      if (!active?.pinched) {
        this.enterRelease(timestamp, false);
      } else if (this.grabPrevious) {
        rotationDelta = {
          x: (active.y - this.grabPrevious.y) * 4.2,
          y: (active.x - this.grabPrevious.x) * 4.2,
        };
        this.grabPrevious = { x: active.x, y: active.y };
      }
    }

    if (this.mode === 'release' && timestamp < this.releaseUntil) {
      return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
    }

    if (this.mode !== 'dual' && !this.dualLocked && pinched.length >= 2) {
      const first = pinched[0]!;
      const second = pinched[1]!;
      const metrics = dualMetrics(first, second);
      if (this.isInsideOrb(metrics.midpoint.x, metrics.midpoint.y, 1.45)) {
        this.mode = 'dual';
        this.cancelPoseActions();
        this.activeGrabId = undefined;
        this.grabPrevious = undefined;
        this.dualAnchor = metrics;
      }
    }

    if (this.mode !== 'dual' && this.mode !== 'grab' && !this.dualLocked) {
      const pressed = actionable.find(
        (reticle) =>
          this.hands.get(reticle.handId)?.justPinched &&
          this.isInsideOrb(reticle.x, reticle.y),
      );
      if (pressed) {
        this.mode = 'grab';
        this.cancelPoseActions();
        this.activeGrabId = pressed.handId;
        this.grabPrevious = { x: pressed.x, y: pressed.y };
        this.releaseUntil = 0;
      }
    }

    if (this.mode === 'dual' || this.mode === 'grab') {
      return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
    }

    if (this.poseLocked) {
      this.mode = actionable.length ? 'awake' : 'ready';
      return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
    }

    const openHands = actionable
      .filter((reticle) => reticle.pose === 'open')
      .sort((first, second) => first.palmX - second.palmX);
    if (openHands.length >= 2) {
      const metrics = palmMetrics(openHands[0]!, openHands[1]!);
      const oppositeSides = openHands[0]!.palmX < 0.47 && openHands[1]!.palmX > 0.53;
      const valid = oppositeSides && this.isInsideOrb(metrics.midpoint.x, metrics.midpoint.y, 1.35);
      if (valid) {
        if (!this.unfold) {
          this.unfold = {
            seenAt: timestamp,
            armed: false,
            anchorDistance: metrics.distance,
            previousDistance: metrics.distance,
            previousAt: timestamp,
            lastOpenAt: timestamp,
          };
        }

        const unfold = this.unfold;
        unfold.lastOpenAt = timestamp;
        if (!unfold.armed && timestamp - unfold.seenAt >= UNFOLD_HOLD_MS) {
          unfold.armed = true;
          unfold.anchorDistance = metrics.distance;
          unfold.previousDistance = metrics.distance;
          unfold.previousAt = timestamp;
        }

        if (unfold.armed) {
          const elapsedSeconds = Math.max((timestamp - unfold.previousAt) / 1000, 1 / 120);
          const spreadSpeed = (metrics.distance - unfold.previousDistance) / elapsedSeconds;
          const totalSpread = metrics.distance - unfold.anchorDistance;
          unfold.previousDistance = metrics.distance;
          unfold.previousAt = timestamp;
          this.mode = 'unfold-armed';

          if (totalSpread >= UNFOLD_SPREAD_DISTANCE && spreadSpeed >= UNFOLD_SPREAD_SPEED) {
            this.mode = 'unfold';
            this.expanded = true;
            this.actionUntil = timestamp + UNFOLD_DURATION_MS;
            this.unfold = undefined;
          }
        }
      } else {
        this.unfold = undefined;
        if (this.mode === 'unfold-armed') this.mode = actionable.length ? 'awake' : 'ready';
      }
    } else if (this.unfold && timestamp - this.unfold.lastOpenAt > 180) {
      this.unfold = undefined;
      if (this.mode === 'unfold-armed') this.mode = actionable.length ? 'awake' : 'ready';
    }

    if (this.mode === 'unfold-armed' || this.mode === 'unfold') {
      return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
    }

    const fist = actionable.find(
      (reticle) => reticle.pose === 'fist' && this.isInsideOrb(reticle.palmX, reticle.palmY, 1.1),
    );
    if (fist && pinched.length === 0) {
      this.charge = {
        handId: fist.handId,
        startedAt: timestamp,
        lastFistAt: timestamp,
        level: 0,
      };
      this.mode = 'charge';
      return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
    }

    this.mode = timestamp < this.releaseUntil
      ? 'release'
      : actionable.length > 0
        ? 'awake'
        : 'ready';
    return this.createSnapshot(reticles, rotationDelta, scaleRatio, rollDelta);
  }

  reset(): void {
    this.hands.clear();
    this.mode = 'ready';
    this.activeGrabId = undefined;
    this.grabPrevious = undefined;
    this.dualAnchor = undefined;
    this.dualLocked = false;
    this.releaseUntil = 0;
    this.actionUntil = 0;
    this.charge = undefined;
    this.unfold = undefined;
    this.expanded = false;
    this.collapseSeenAt = 0;
    this.timestamp = 0;
    this.poseLocked = false;
    this.fieldDualAnchor = undefined;
    this.fieldDualLocked = false;
    this.fieldControl = false;
  }

  private updateHand(observation: HandObservation, timestamp: number): void {
    const indexTip = observation.landmarks[8];
    if (!indexTip) return;
    const ratio = pinchRatio(observation.landmarks);
    const classifiedPose = classifyHandPose(observation.landmarks);
    // Pinch is the primary control. A compact pinch can visually resemble a
    // fist, so never let the charge pose suppress an already-valid pinch.
    const detectedPose = classifiedPose === 'fist' && ratio < PINCH_ENGAGE_RATIO
      ? 'neutral'
      : classifiedPose;
    const palm = palmPoint(observation.landmarks) ?? indexTip;
    const pointer = detectedPose === 'fist'
      ? palm
      : pinchPoint(observation.landmarks, ratio) ?? indexTip;
    const mapped = mapCameraPoint(pointer.x, pointer.y, this.calibration);
    const mappedPalm = mapCameraPoint(palm.x, palm.y, this.calibration);
    const runtime = this.hands.get(observation.id) ?? {
      id: observation.id,
      handedness: observation.handedness,
      xFilter: new OneEuroFilter(),
      yFilter: new OneEuroFilter(),
      palmXFilter: new OneEuroFilter(),
      palmYFilter: new OneEuroFilter(),
      x: mapped.x,
      y: mapped.y,
      palmX: mappedPalm.x,
      palmY: mappedPalm.y,
      pinched: false,
      candidatePinched: false,
      candidateFrames: 0,
      justPinched: false,
      pinchStrength: 0,
      pose: 'neutral' as HandPose,
      candidatePose: 'neutral' as HandPose,
      candidatePoseFrames: 0,
      score: observation.score,
      lastSeen: timestamp,
    };

    runtime.justPinched = false;
    runtime.handedness = observation.handedness;
    runtime.x = runtime.xFilter.filter(mapped.x, timestamp);
    runtime.y = runtime.yFilter.filter(mapped.y, timestamp);
    runtime.palmX = runtime.palmXFilter.filter(mappedPalm.x, timestamp);
    runtime.palmY = runtime.palmYFilter.filter(mappedPalm.y, timestamp);
    runtime.score = observation.score;
    runtime.lastSeen = timestamp;
    runtime.pinchStrength = pinchStrength(ratio);

    const nextCandidate = detectedPose === 'fist'
      ? false
      : runtime.pinched
        ? ratio < PINCH_RELEASE_RATIO
        : ratio < PINCH_ENGAGE_RATIO;
    if (nextCandidate === runtime.candidatePinched) runtime.candidateFrames += 1;
    else {
      runtime.candidatePinched = nextCandidate;
      runtime.candidateFrames = 1;
    }

    if (runtime.candidateFrames >= 2 && runtime.pinched !== nextCandidate) {
      runtime.pinched = nextCandidate;
      runtime.justPinched = nextCandidate;
    }

    const nextPose = detectedPose === 'fist'
      ? 'fist'
      : ratio < PINCH_RELEASE_RATIO
        ? 'neutral'
        : detectedPose;
    if (nextPose === runtime.candidatePose) runtime.candidatePoseFrames += 1;
    else {
      runtime.candidatePose = nextPose;
      runtime.candidatePoseFrames = 1;
    }
    if (runtime.candidatePoseFrames >= 2) runtime.pose = nextPose;
    this.hands.set(observation.id, runtime);
  }

  private createReticles(timestamp: number): ReticleState[] {
    return [...this.hands.values()].map((hand) => {
      const age = timestamp - hand.lastSeen;
      const visibility = age <= 100 ? 1 : clamp(1 - (age - 100) / 150, 0, 1);
      return {
        handId: hand.id,
        handedness: hand.handedness,
        x: hand.x,
        y: hand.y,
        pinched: hand.pinched,
        pinchStrength: hand.pinchStrength,
        pose: hand.pose,
        palmX: hand.palmX,
        palmY: hand.palmY,
        visibility,
      };
    });
  }

  private isInsideOrb(x: number, y: number, radiusMultiplier = 1): boolean {
    const { width, height } = this.viewport();
    const distance = Math.hypot((x - 0.5) * width, (y - 0.5) * height);
    return distance <= Math.min(width, height) * 0.33 * radiusMultiplier;
  }

  private enterRelease(timestamp: number, lockDual: boolean): void {
    this.mode = 'release';
    this.releaseUntil = timestamp + 300;
    this.activeGrabId = undefined;
    this.grabPrevious = undefined;
    this.dualAnchor = undefined;
    if (lockDual) this.dualLocked = true;
  }

  private cancelPoseActions(): void {
    this.charge = undefined;
    this.unfold = undefined;
  }

  private createSnapshot(
    reticles: ReticleState[],
    rotationDelta: { x: number; y: number },
    scaleRatio: number,
    rollDelta: number,
  ): GestureSnapshot {
    const actionable = reticles.filter((reticle) => reticle.visibility > 0.6);
    const trackingQuality = actionable.length
      ? actionable.reduce((sum, reticle) => sum + (this.hands.get(reticle.handId)?.score ?? 0), 0) /
        actionable.length
      : 0;
    const chargeLevel = this.mode === 'charge' ? this.charge?.level ?? 0 : 0;
    const intensity = gestureIntensity(this.mode, chargeLevel, actionable.length > 0);
    return {
      timestamp: this.timestamp,
      mode: this.mode,
      reticles,
      rotationDelta,
      scaleRatio,
      rollDelta,
      fieldControl: this.fieldControl,
      chargeLevel,
      intensity,
      trackingQuality,
    };
  }
}

function dualMetrics(first: ReticleState, second: ReticleState): DualAnchor {
  return {
    distance: Math.max(Math.hypot(second.x - first.x, second.y - first.y), 0.001),
    angle: Math.atan2(second.y - first.y, second.x - first.x),
    midpoint: {
      x: (first.x + second.x) / 2,
      y: (first.y + second.y) / 2,
    },
  };
}

function palmMetrics(first: ReticleState, second: ReticleState): DualAnchor {
  return {
    distance: Math.max(Math.hypot(second.palmX - first.palmX, second.palmY - first.palmY), 0.001),
    angle: Math.atan2(second.palmY - first.palmY, second.palmX - first.palmX),
    midpoint: {
      x: (first.palmX + second.palmX) / 2,
      y: (first.palmY + second.palmY) / 2,
    },
  };
}

function palmPoint(landmarks: Landmark[]): Landmark | null {
  const points = [0, 5, 9, 13, 17]
    .map((index) => landmarks[index])
    .filter((point): point is Landmark => Boolean(point));
  if (points.length < 4) return null;
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
    z: points.reduce((sum, point) => sum + point.z, 0) / points.length,
  };
}

function gestureIntensity(mode: GestureMode, chargeLevel: number, hasHands: boolean): number {
  if (mode === 'dual' || mode === 'unfold') return 1;
  if (mode === 'burst') return 0.72;
  if (mode === 'grab') return 0.76;
  if (mode === 'charge') return 0.3 + chargeLevel * 0.28;
  if (mode === 'unfold-armed') return 0.5;
  if (mode === 'expanded') return 0.42;
  if (mode === 'collapse') return 0.72;
  return hasHands ? 0.26 : 0;
}

function normalizeAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pinchStrength(ratio: number): number {
  return clamp(
    (PINCH_RELEASE_RATIO - ratio) / (PINCH_RELEASE_RATIO - PINCH_MIN_RATIO),
    0,
    1,
  );
}

function landmarkDistance(first: Landmark, second: Landmark, depthWeight: number): number {
  return Math.hypot(
    first.x - second.x,
    first.y - second.y,
    (first.z - second.z) * depthWeight,
  );
}

function lerp(from: number, to: number, amount: number): number {
  return from + (to - from) * amount;
}
