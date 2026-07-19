import type { GestureSnapshot } from '../../core/types';
import type { ControlAuthority } from '../types';

export class InputArbiter {
  private authority: ControlAuthority = 'ambient';
  private handLostAt: number | null = null;

  updateHands(snapshot: GestureSnapshot, now = performance.now()): ControlAuthority {
    const handPresent = snapshot.reticles.some((reticle) => reticle.visibility >= 0.35);
    if (handPresent) {
      this.handLostAt = null;
      this.authority = 'hand';
    } else if (this.authority === 'hand') {
      this.handLostAt ??= now;
      if (now - this.handLostAt >= 300) this.authority = 'ambient';
    }
    return this.authority;
  }

  requestVoice(): boolean {
    if (this.authority === 'hand') return false;
    this.authority = 'voice';
    return true;
  }

  settleVoice(): void {
    if (this.authority === 'voice') this.authority = 'ambient';
  }

  get current(): ControlAuthority {
    return this.authority;
  }
}
