import { describe, expect, it, vi } from 'vitest';
import {
  runOrionVoiceWorkflow,
  type ReceivedVoiceTranscript,
} from '../../../../src/voice/workflow/runOrionVoiceWorkflow';
import type { GeneratedVoiceTurn } from '../../../../src/voice/workflow/geminiTurnClient';

describe('runOrionVoiceWorkflow', () => {
  it('keeps the complete voice turn in four visible stages', async () => {
    const order: string[] = [];
    const transcript: ReceivedVoiceTranscript = {
      text: 'How are you?',
      history: [],
      controller: new AbortController(),
    };
    const turn: GeneratedVoiceTurn = {
      spokenText: 'Operational and slightly dramatic.',
      screenText: '**Operational.** Slightly dramatic.',
      sources: [],
    };

    const completed = await runOrionVoiceWorkflow('  How are you?  ', {
      receiveTranscript: (raw) => {
        order.push(`receive:${raw}`);
        return transcript;
      },
      generateGeminiTurn: async (received) => {
        order.push(`generate:${received.text}`);
        return turn;
      },
      commitConversationTurn: (received, generated) => {
        order.push(`commit:${received.text}:${generated.screenText}`);
      },
      presentGeneratedTurn: async (generated) => {
        order.push(`present:${generated.screenText}:${generated.spokenText}`);
      },
    });

    expect(completed).toBe(true);
    expect(order).toEqual([
      'receive:  How are you?  ',
      'generate:How are you?',
      'commit:How are you?:**Operational.** Slightly dramatic.',
      'present:**Operational.** Slightly dramatic.:Operational and slightly dramatic.',
    ]);
  });

  it('stops before Gemini when the transcript is rejected', async () => {
    const generateGeminiTurn = vi.fn();
    expect(await runOrionVoiceWorkflow('', {
      receiveTranscript: () => null,
      generateGeminiTurn,
      commitConversationTurn: vi.fn(),
      presentGeneratedTurn: vi.fn(),
    })).toBe(false);
    expect(generateGeminiTurn).not.toHaveBeenCalled();
  });
});
