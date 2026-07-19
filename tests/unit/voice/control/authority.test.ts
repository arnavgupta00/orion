import { describe, expect, it } from 'vitest';
import type { GestureSnapshot } from '../../../../src/core/types';
import { InputArbiter } from '../../../../src/voice/control/authority';

describe('InputArbiter', () => {
  it('gives a stable hand immediate authority and rejects voice', () => {
    const arbiter = new InputArbiter();
    expect(arbiter.requestVoice()).toBe(true);
    expect(arbiter.updateHands(snapshot(0.9), 10)).toBe('hand');
    expect(arbiter.requestVoice()).toBe(false);
  });

  it('returns authority only after hands have been absent for 300ms', () => {
    const arbiter = new InputArbiter();
    arbiter.updateHands(snapshot(1), 0);
    expect(arbiter.updateHands(snapshot(0), 100)).toBe('hand');
    expect(arbiter.updateHands(snapshot(0), 399)).toBe('hand');
    expect(arbiter.updateHands(snapshot(0), 400)).toBe('ambient');
  });
});

function snapshot(visibility: number): GestureSnapshot {
  return {
    timestamp: 0,
    mode: visibility ? 'awake' : 'ready',
    reticles: visibility ? [{
      handId: 'hand', handedness: 'Left', x: 0.5, y: 0.5, palmX: 0.5, palmY: 0.5,
      pinched: false, pinchStrength: 0, pose: 'neutral', visibility,
    }] : [],
    rotationDelta: { x: 0, y: 0 }, scaleRatio: 1, rollDelta: 0, fieldControl: false,
    chargeLevel: 0, intensity: 0, trackingQuality: visibility,
  };
}
