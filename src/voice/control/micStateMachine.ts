import type { MicState } from '../types';

export interface MicStateCallbacks {
  onStart(latched: boolean): void;
  onFinalize(latched: boolean): void;
  onCancelResponse(): void;
  onState(state: MicState): void;
}

const DOUBLE_TAP_MS = 300;
const HOLD_MS = 240;

export class MicStateMachine {
  private state: MicState = 'idle';
  private keyDownAt = 0;
  private holdTimer?: ReturnType<typeof setTimeout>;
  private singleTimer?: ReturnType<typeof setTimeout>;
  private waitingSecondTap = false;
  private listening = false;

  constructor(private readonly callbacks: MicStateCallbacks) {}

  keyDown(now = performance.now()): void {
    // Errors are terminal feedback, not a terminal microphone state. A new
    // Space press must always be able to start a fresh capture.
    if (this.state === 'error') this.reset();
    if (this.state === 'latched') {
      this.finish(false);
      return;
    }
    if (this.state === 'speaking' || this.state === 'thinking') {
      this.callbacks.onCancelResponse();
      this.begin(false, now);
      return;
    }
    if (this.waitingSecondTap) {
      clearTimeout(this.singleTimer);
      this.waitingSecondTap = false;
      this.keyDownAt = now;
      this.setState('latched');
      if (!this.listening) this.startListening(true);
      return;
    }
    if (this.state !== 'idle' || this.keyDownAt) return;
    this.begin(false, now);
  }

  keyUp(now = performance.now()): void {
    if (!this.keyDownAt || this.state === 'latched') return;
    const heldFor = now - this.keyDownAt;
    this.keyDownAt = 0;
    clearTimeout(this.holdTimer);
    if (heldFor >= HOLD_MS) {
      this.finish(false);
      return;
    }
    this.waitingSecondTap = true;
    this.singleTimer = setTimeout(() => {
      this.waitingSecondTap = false;
      this.finish(false);
    }, DOUBLE_TAP_MS - heldFor);
  }

  pointerStart(): void {
    if (this.state === 'latched') this.finish(false);
    else this.begin(false, performance.now());
  }

  pointerEnd(): void {
    if (this.state === 'hold') this.finish(false);
  }

  latch(): void {
    if (this.state === 'speaking' || this.state === 'thinking') this.callbacks.onCancelResponse();
    this.setState('latched');
    if (!this.listening) this.startListening(true);
  }

  finalize(): void {
    this.finish(false);
  }

  setProcessing(state: 'thinking' | 'speaking'): void {
    this.listening = false;
    this.setState(state);
  }

  completeTurn(): void {
    this.listening = false;
    this.setState('idle');
  }

  fail(): void {
    this.listening = false;
    this.setState('error');
  }

  reset(): void {
    this.listening = false;
    this.waitingSecondTap = false;
    this.keyDownAt = 0;
    clearTimeout(this.holdTimer);
    clearTimeout(this.singleTimer);
    this.setState('idle');
  }

  destroy(): void {
    this.reset();
  }

  get current(): MicState {
    return this.state;
  }

  private begin(latched: boolean, now: number): void {
    this.keyDownAt = now;
    this.startListening(latched);
    this.holdTimer = setTimeout(() => {
      if (this.keyDownAt && this.state !== 'latched') this.setState('hold');
    }, HOLD_MS);
  }

  private startListening(latched: boolean): void {
    this.listening = true;
    this.setState(latched ? 'latched' : 'hold');
    this.callbacks.onStart(latched);
  }

  private finish(latched: boolean): void {
    if (!this.listening) {
      this.setState('idle');
      return;
    }
    this.listening = false;
    this.keyDownAt = 0;
    this.setState('finalizing');
    this.callbacks.onFinalize(latched);
  }

  private setState(state: MicState): void {
    this.state = state;
    this.callbacks.onState(state);
  }
}
