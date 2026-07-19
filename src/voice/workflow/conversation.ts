import type { ConversationTurn } from '../types';

export function appendHistory(history: ConversationTurn[], turn: ConversationTurn): ConversationTurn[] {
  const bounded: ConversationTurn = turn.role === 'user'
    ? { role: 'user', text: turn.text.slice(0, 2_000) }
    : {
        role: 'assistant',
        spokenText: turn.spokenText.slice(0, 650),
        screenText: turn.screenText.slice(0, 12_000),
      };
  const recent = [...history, bounded].slice(-42);
  const result: ConversationTurn[] = [];
  let characters = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const candidate = recent[index]!;
    const size = candidate.role === 'user'
      ? candidate.text.length
      : candidate.spokenText.length + candidate.screenText.length;
    if (characters + size > 84_000) break;
    result.unshift(candidate);
    characters += size;
  }
  return result;
}

export function speakablePrefix(text: string, complete: boolean): string {
  const bounded = firstSentences(text, 2, 520);
  if (!bounded) return '';
  if (complete) return bounded;
  const boundary = /[.!?][\]"')]*(?:\s|$)/.exec(bounded);
  if (!boundary || boundary.index < 12) return '';
  return bounded.slice(0, boundary.index + boundary[0].trimEnd().length).trim();
}

function firstSentences(text: string, count: number, maxLength: number): string {
  const sentences = text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
  return sentences.slice(0, count).join(' ').trim().slice(0, maxLength);
}
