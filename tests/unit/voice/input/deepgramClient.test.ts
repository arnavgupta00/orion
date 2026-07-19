import { describe, expect, it } from 'vitest';
import { buildDeepgramListenUrl, ORION_KEYTERMS } from '../../../../src/voice/input/deepgramClient';

describe('Deepgram recognition vocabulary', () => {
  it('boosts orb aliases and the complete scene command vocabulary', () => {
    const url = buildDeepgramListenUrl(48_000);
    const boosted = url.searchParams.getAll('keyterm');

    expect(boosted).toEqual(ORION_KEYTERMS);
    expect(boosted).toEqual(expect.arrayContaining([
      'orb',
      'ball',
      'balls',
      'open the field',
      'collapse the field',
      'zoom in',
      'zoom out',
      'release energy',
      'increase brightness',
      'reset',
    ]));
  });
});
