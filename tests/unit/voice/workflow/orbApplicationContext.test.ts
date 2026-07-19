import { describe, expect, it } from 'vitest';
import { ORION_ORB_APPLICATION_CONTEXT } from '../../../../src/voice/intelligence/orbApplicationContext';

describe('Orion orb application context', () => {
  it('separates zoom, source size, brightness, energy, field, and appearance', () => {
    expect(ORION_ORB_APPLICATION_CONTEXT).toContain('CORE GROUP');
    expect(ORION_ORB_APPLICATION_CONTEXT).toContain('WORLD LATTICE GROUP');
    expect(ORION_ORB_APPLICATION_CONTEXT).toContain('DEPTH GROUP');
    expect(ORION_ORB_APPLICATION_CONTEXT).toContain('orb_transform.zoomFactor');
    expect(ORION_ORB_APPLICATION_CONTEXT).toContain('orb_set_core.size');
    expect(ORION_ORB_APPLICATION_CONTEXT).toContain('orb_set_core.brightness');
    expect(ORION_ORB_APPLICATION_CONTEXT).toContain('orb_set_core.energy');
    expect(ORION_ORB_APPLICATION_CONTEXT).toContain('orb_set_appearance');
    expect(ORION_ORB_APPLICATION_CONTEXT).toContain('Never use modify_orion_ui');
  });
});
