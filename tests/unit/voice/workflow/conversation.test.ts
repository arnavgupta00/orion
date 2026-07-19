import { describe, expect, it } from 'vitest';
import { appendHistory, speakablePrefix } from '../../../../src/voice/workflow/conversation';
import type { ConversationTurn } from '../../../../src/voice/types';

describe('Orion conversation memory', () => {
  it('keeps the complete 21-turn session in browser memory', () => {
    let history: ConversationTurn[] = [];
    for (let index = 0; index < 46; index += 1) {
      history = appendHistory(history, index % 2
        ? { role: 'assistant', spokenText: `turn ${index}`, screenText: `turn ${index}` }
        : { role: 'user', text: `turn ${index}` });
    }
    expect(history).toHaveLength(42);
    expect(history[0]).toEqual({ role: 'user', text: 'turn 4' });
    expect(history.at(-1)).toEqual({ role: 'assistant', spokenText: 'turn 45', screenText: 'turn 45' });
  });

  it('bounds each message before sending it back to the model', () => {
    const history = appendHistory([], {
      role: 'assistant',
      spokenText: 'x'.repeat(4_000),
      screenText: 'x'.repeat(20_000),
    });
    expect(history[0]).toMatchObject({ role: 'assistant' });
    if (history[0]?.role !== 'assistant') throw new Error('Expected assistant history.');
    expect(history[0].spokenText).toHaveLength(650);
    expect(history[0].screenText).toHaveLength(12_000);
  });

  it('bounds the complete browser-memory payload before an API request', () => {
    let history: ConversationTurn[] = [];
    for (let index = 0; index < 42; index += 1) {
      history = appendHistory(history, {
        role: 'assistant',
        spokenText: `spoken ${index}`,
        screenText: 'x'.repeat(12_000),
      });
    }
    const size = history.reduce((total, turn) => total + (turn.role === 'user'
      ? turn.text.length
      : turn.spokenText.length + turn.screenText.length), 0);
    expect(size).toBeLessThanOrEqual(84_000);
    expect(history.at(-1)).toMatchObject({ role: 'assistant', screenText: 'x'.repeat(12_000) });
  });
});

describe('streaming speech prefix', () => {
  it('starts speech as soon as the first complete sentence arrives', () => {
    expect(speakablePrefix('That is the short answer. Here is the detail', false))
      .toBe('That is the short answer.');
  });

  it('waits for a sentence boundary while text is still streaming', () => {
    expect(speakablePrefix('That is still an unfinished thought', false)).toBe('');
    expect(speakablePrefix('That is still an unfinished thought', true))
      .toBe('That is still an unfinished thought');
  });
});
