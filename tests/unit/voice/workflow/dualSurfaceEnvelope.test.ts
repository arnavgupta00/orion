import { describe, expect, it } from 'vitest';
import {
  DualSurfaceEnvelopeParser,
  MAX_SCREEN_TEXT,
  MAX_SPOKEN_TEXT,
  ORION_END_MARKER,
  ORION_SCREEN_MARKER,
  ORION_SPEECH_MARKER,
} from '../../../../src/voice/workflow/dualSurfaceEnvelope';

function parse(chunks: string[]): {
  spoken: string;
  screen: string;
  result: { spokenText: string; screenText: string };
} {
  let spoken = '';
  let screen = '';
  const parser = new DualSurfaceEnvelopeParser({
    onSpeechDelta: (text) => { spoken += text; },
    onScreenDelta: (text) => { screen += text; },
  });
  chunks.forEach((chunk) => parser.push(chunk));
  return { spoken, screen, result: parser.finish() };
}

describe('dual-surface Gemini envelope', () => {
  it('recognizes markers split across every possible chunk boundary', () => {
    const response = `${ORION_SPEECH_MARKER}\nA concise answer.${ORION_SCREEN_MARKER}\n## Detail\n\nUseful evidence.${ORION_END_MARKER}`;
    const parsed = parse([...response]);
    expect(parsed.spoken.trim()).toBe('A concise answer.');
    expect(parsed.screen.trim()).toBe('## Detail\n\nUseful evidence.');
    expect(parsed.result).toEqual({
      spokenText: 'A concise answer.',
      screenText: '## Detail\n\nUseful evidence.',
    });
    expect(parsed.spoken + parsed.screen).not.toContain('<<<ORION_');
  });

  it('allows a silent speech channel for pure visual commands', () => {
    const parsed = parse([
      `${ORION_SPEECH_MARKER}\n${ORION_SCREEN_MARKER}\nField opened.${ORION_END_MARKER}`,
    ]);
    expect(parsed.result).toEqual({ spokenText: '', screenText: 'Field opened.' });
  });

  it('repairs an unformatted answer without exposing protocol syntax', () => {
    const parsed = parse(['Direct answer. More useful detail follows.']);
    expect(parsed.result.spokenText).toBe('Direct answer. More useful detail follows.');
    expect(parsed.result.screenText).toBe('Direct answer. More useful detail follows.');
  });

  it('bounds both response surfaces', () => {
    const parsed = parse([
      `${ORION_SPEECH_MARKER}${'s'.repeat(MAX_SPOKEN_TEXT + 100)}`,
      `${ORION_SCREEN_MARKER}${'d'.repeat(MAX_SCREEN_TEXT + 100)}${ORION_END_MARKER}`,
    ]);
    expect(parsed.result.spokenText).toHaveLength(MAX_SPOKEN_TEXT);
    expect(parsed.result.screenText).toHaveLength(MAX_SCREEN_TEXT);
  });
});
