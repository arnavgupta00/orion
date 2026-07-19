import { describe, expect, it } from 'vitest';
import {
  normalizeHttpUrl,
  normalizeOrbHexColor,
  serializableValue,
} from '../../../../src/voice/tools/pageToolRunner';

describe('Orion page tool helpers', () => {
  it('normalizes safe links and rejects non-web protocols', () => {
    expect(normalizeHttpUrl('github.com/arnavgupta00')).toBe('https://github.com/arnavgupta00');
    expect(() => normalizeHttpUrl('javascript:alert(1)')).toThrow('Only HTTP and HTTPS');
  });

  it('serializes cycles and bigint without throwing', () => {
    const value: { count: bigint; self?: unknown } = { count: 12n };
    value.self = value;
    expect(serializableValue(value)).toEqual({ count: '12', self: '[Circular]' });
  });

  it('truncates oversized results', () => {
    expect(serializableValue({ text: 'x'.repeat(9_000) })).toMatchObject({ truncated: true });
  });

  it('normalizes orb colors and rejects ambiguous CSS values', () => {
    expect(normalizeOrbHexColor('#3df')).toBe('#33DDFF');
    expect(normalizeOrbHexColor('#c8162e')).toBe('#C8162E');
    expect(() => normalizeOrbHexColor('blue')).toThrow('six-digit hex color');
  });
});
