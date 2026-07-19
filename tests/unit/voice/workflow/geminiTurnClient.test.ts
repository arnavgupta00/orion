import { afterEach, describe, expect, it, vi } from 'vitest';
import { GeminiTurnClient } from '../../../../src/voice/workflow/geminiTurnClient';
import type { ClientState } from '../../../../src/voice/types';

const CLIENT_STATE: ClientState = {
  authority: 'ambient',
  orb: {
    mode: 'ready',
    fieldOpen: false,
    zoomLog: 0,
    sourceSize: 0.77,
    brightness: 1.5,
    energy: 0,
    appearance: { shell: null, lightSource: null, field: null },
  },
  microphone: 'thinking',
  fullscreen: false,
};

afterEach(() => vi.restoreAllMocks());

describe('Gemini agent turn client', () => {
  it('posts the finalized displayed transcript to the agent', async () => {
    let sentBody: BodyInit | null | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sentBody = init?.body;
      return new Response([
        'data: {"type":"speech-delta","text":"Doing well."}',
        '',
        'data: {"type":"screen-delta","text":"**Doing well.** Systems nominal."}',
        '',
        'data: {"type":"done"}',
        '',
      ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } });
    });

    const client = new GeminiTurnClient({
      getClientState: () => CLIENT_STATE,
      executeClientTool: vi.fn(),
      onScreenText: vi.fn(),
      onSpeakableText: vi.fn(),
      onSources: vi.fn(),
      onEvent: vi.fn(),
      onClientToolResult: vi.fn(),
    });
    const turn = await client.generateTurn({
      text: 'How are you doing?',
      history: [],
      controller: new AbortController(),
    });

    const body = JSON.parse(String(sentBody));
    expect(body.transcript).toBe('How are you doing?');
    expect(turn).toEqual({
      spokenText: 'Doing well.',
      screenText: '**Doing well.** Systems nominal.',
      sources: [],
    });
  });

  it('emits the first complete sentence before the SSE response is finished', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response([
      'data: {"type":"speech-delta","text":"I am doing well."}',
      '',
      'data: {"type":"speech-delta","text":" The rest can keep streaming."}',
      '',
      'data: {"type":"screen-delta","text":"A detailed screen response."}',
      '',
      'data: {"type":"done"}',
      '',
    ].join('\n'), { headers: { 'Content-Type': 'text/event-stream' } }));
    const onSpeakableText = vi.fn();
    const client = new GeminiTurnClient({
      getClientState: () => CLIENT_STATE,
      executeClientTool: vi.fn(),
      onScreenText: vi.fn(),
      onSpeakableText,
      onSources: vi.fn(),
      onEvent: vi.fn(),
      onClientToolResult: vi.fn(),
    });

    await client.generateTurn({
      text: 'How are you?',
      history: [],
      controller: new AbortController(),
    });

    expect(onSpeakableText).toHaveBeenCalledOnce();
    expect(onSpeakableText).toHaveBeenCalledWith('I am doing well.');
  });
});
