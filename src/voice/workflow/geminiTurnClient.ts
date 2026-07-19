import type {
  ClientState,
  ClientToolResult,
  SourceLink,
  VoiceTurnEvent,
} from '../types';
import { apiError, providerError } from '../api/providerErrors';
import type { ReceivedVoiceTranscript } from './runOrionVoiceWorkflow';
import { speakablePrefix } from './conversation';

export type ClientToolCallEvent = Extract<VoiceTurnEvent, { type: 'client-tool-call' }>;

export interface GeneratedVoiceTurn {
  spokenText: string;
  screenText: string;
  sources: SourceLink[];
}

export interface GeminiTurnClientCallbacks {
  getClientState(): ClientState;
  executeClientTool(call: ClientToolCallEvent): Promise<ClientToolResult>;
  onScreenText(text: string): void;
  onSpeakableText(text: string): void;
  onSources(sources: SourceLink[]): void;
  onEvent(event: VoiceTurnEvent): void;
  onClientToolResult(call: ClientToolCallEvent, result: ClientToolResult): void;
}

interface AgentRound {
  spokenText: string;
  screenText: string;
  sources: SourceLink[];
  clientCalls: ClientToolCallEvent[];
  continuation?: string;
  done: boolean;
}

/** Owns the Gemini SSE request, server tools, and browser-tool continuation loop. */
export class GeminiTurnClient {
  constructor(private readonly callbacks: GeminiTurnClientCallbacks) {}

  async generateTurn(input: ReceivedVoiceTranscript): Promise<GeneratedVoiceTurn> {
    let requestBody: Record<string, unknown> = {
      kind: 'start',
      transcript: input.text,
      history: input.history,
      clientState: this.callbacks.getClientState(),
    };
    let spokenText = '';
    let screenText = '';
    let sources: SourceLink[] = [];
    let speechStarted = false;

    for (let roundIndex = 0; roundIndex < 7; roundIndex += 1) {
      const response = await fetch('/api/respond', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: input.controller.signal,
      });
      if (!response.ok) throw await apiError(response);

      const round = await this.consumeEvents(response, spokenText, screenText, sources, (streamedSpeech) => {
        if (speechStarted) return;
        const prefix = speakablePrefix(streamedSpeech, false);
        if (!prefix) return;
        speechStarted = true;
        this.callbacks.onSpeakableText(prefix);
      });
      spokenText = round.spokenText;
      screenText = round.screenText;
      sources = round.sources;
      if (!round.clientCalls.length) {
        if (!round.done) throw new Error('Orion ended the tool loop without a final response.');
        return { spokenText, screenText, sources };
      }
      if (!round.continuation) throw new Error('Orion did not return a valid tool continuation.');

      const toolResults: ClientToolResult[] = [];
      for (const call of round.clientCalls) {
        const result = await this.callbacks.executeClientTool(call);
        toolResults.push(result);
        this.callbacks.onClientToolResult(call, result);
      }
      requestBody = {
        kind: 'continue',
        continuation: round.continuation,
        toolResults,
        clientState: this.callbacks.getClientState(),
      };
    }

    throw new Error('Orion exceeded the browser tool round limit.');
  }

  private async consumeEvents(
    response: Response,
    initialSpokenText: string,
    initialScreenText: string,
    initialSources: SourceLink[],
    onStreamedSpeech: (text: string) => void,
  ): Promise<AgentRound> {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Orion returned an empty response.');
    const decoder = new TextDecoder();
    let buffer = '';
    let spokenText = initialSpokenText;
    let screenText = initialScreenText;
    let sources = initialSources;
    let continuation: string | undefined;
    let doneEvent = false;
    const clientCalls: ClientToolCallEvent[] = [];

    const consumeRecord = (record: string): void => {
      const data = record.split('\n').find((line) => line.startsWith('data: '))?.slice(6);
      if (!data) return;
      const event = JSON.parse(data) as VoiceTurnEvent;

      if (event.type === 'speech-delta') {
        spokenText += event.text;
        onStreamedSpeech(spokenText);
      } else if (event.type === 'screen-delta') {
        screenText += event.text;
        this.callbacks.onScreenText(screenText);
      } else if (event.type === 'sources') {
        sources = mergeSources(sources, event.sources);
        this.callbacks.onSources(sources);
      } else if (event.type === 'client-tool-call') {
        clientCalls.push(event);
        continuation ??= event.continuation;
        if (continuation !== event.continuation) {
          throw new Error('Orion returned mismatched tool continuations.');
        }
      } else if (event.type === 'done') {
        doneEvent = true;
      } else if (event.type === 'error') {
        throw providerError(event.code, event.message);
      } else {
        this.callbacks.onEvent(event);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const records = buffer.split('\n\n');
      buffer = records.pop() ?? '';
      records.forEach(consumeRecord);
      if (done) break;
    }
    if (buffer.trim()) consumeRecord(buffer);

    return {
      spokenText,
      screenText,
      sources,
      clientCalls,
      ...(continuation ? { continuation } : {}),
      done: doneEvent,
    };
  }
}

function mergeSources(current: SourceLink[], incoming: SourceLink[]): SourceLink[] {
  const byUrl = new Map(current.map((source) => [source.url, source]));
  incoming.forEach((source) => {
    if (source.url && !byUrl.has(source.url)) byUrl.set(source.url, source);
  });
  return [...byUrl.values()].slice(0, 12);
}
