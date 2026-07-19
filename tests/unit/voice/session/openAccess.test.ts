import { describe, expect, it } from 'vitest';
import {
  isOpenAccessActive,
  openAccessDeadline,
  publicSessionExpiry,
} from '../../../../src/voice/session/openAccess';

describe('temporary open access', () => {
  const deadline = '2026-07-22T22:22:35Z';
  const deadlineMs = Date.parse(deadline);

  it('is active only before a valid UTC deadline', () => {
    expect(isOpenAccessActive(deadline, deadlineMs - 1)).toBe(true);
    expect(isOpenAccessActive(deadline, deadlineMs)).toBe(false);
    expect(isOpenAccessActive('not-a-date', deadlineMs - 1)).toBe(false);
  });

  it('uses the open-window deadline as the public session expiry', () => {
    expect(publicSessionExpiry(deadline, deadlineMs - 60_000, 15 * 60_000)).toBe(deadlineMs);
    expect(publicSessionExpiry(deadline, deadlineMs, 15 * 60_000)).toBe(deadlineMs + 15 * 60_000);
  });

  it('rejects ambiguous non-UTC timestamps', () => {
    expect(openAccessDeadline('2026-07-22')).toBeNull();
    expect(openAccessDeadline(undefined)).toBeNull();
  });
});
