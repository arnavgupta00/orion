import { describe, expect, it } from 'vitest';
import {
  buildGeminiTranscriptionPrompt,
  ORION_TRANSCRIPTION_TERMS,
} from '../../../../src/voice/input/transcriptionVocabulary';

describe('Orion transcription vocabulary', () => {
  it('covers identity, technical, orb, gesture, and page-action language', () => {
    expect(ORION_TRANSCRIPTION_TERMS).toEqual(expect.arrayContaining([
      'Arnav Gupta',
      'Oracia',
      'Gemini 3.1 Flash-Lite',
      'Deepgram',
      'Wispr Flow',
      'Cloudflare Workers',
      'MediaPipe',
      'Durable Objects',
      'GAIA benchmark',
      'orb',
      'triangle lattice',
      'pinch and drag',
      'open the field',
      'increase core size',
      'open GitHub',
    ]));
  });

  it('treats vocabulary as contextual spelling hints instead of forced substitutions', () => {
    const prompt = buildGeminiTranscriptionPrompt();
    expect(prompt).toContain('Return only the verbatim transcript');
    expect(prompt).toContain('Never insert, substitute, or force a listed term');
    expect(prompt).toContain('Deepgram (not "Deep Ground")');
    expect(prompt).toContain('Preserve ordinary words');
  });
});
