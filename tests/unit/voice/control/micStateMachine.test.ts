import { afterEach, describe, expect, it, vi } from 'vitest';
import { MicStateMachine } from '../../../../src/voice/control/micStateMachine';

afterEach(() => vi.useRealTimers());

describe('MicStateMachine', () => {
  it('uses a held Space as push-to-talk', () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const machine = build(events);
    machine.keyDown(100);
    machine.keyUp(400);
    expect(events).toContain('start:false');
    expect(events).toContain('finalize:false');
    expect(machine.current).toBe('finalizing');
  });

  it('latches on a second tap within 300ms', () => {
    vi.useFakeTimers();
    const events: string[] = [];
    const machine = build(events);
    machine.keyDown(100);
    machine.keyUp(170);
    machine.keyDown(310);
    expect(machine.current).toBe('latched');
    expect(events.filter((event) => event.startsWith('start'))).toEqual(['start:false']);
  });

  it('interrupts speech before starting a new recording', () => {
    const events: string[] = [];
    const machine = build(events);
    machine.setProcessing('speaking');
    machine.keyDown(100);
    expect(events.slice(-3)).toEqual(['cancel', 'state:hold', 'start:false']);
  });

  it('lets the toolbar checkmark finalize the captured turn', () => {
    const events: string[] = [];
    const machine = build(events);
    machine.latch();
    machine.finalize();
    expect(events).toContain('finalize:false');
    expect(machine.current).toBe('finalizing');
  });

  it('starts a fresh capture when Space is pressed after an error', () => {
    const events: string[] = [];
    const machine = build(events);
    machine.fail();
    machine.keyDown(100);
    expect(machine.current).toBe('hold');
    expect(events.slice(-3)).toEqual(['state:idle', 'state:hold', 'start:false']);
  });
});

function build(events: string[]): MicStateMachine {
  return new MicStateMachine({
    onStart: (latched) => events.push(`start:${latched}`),
    onFinalize: (latched) => events.push(`finalize:${latched}`),
    onCancelResponse: () => events.push('cancel'),
    onState: (state) => events.push(`state:${state}`),
  });
}
