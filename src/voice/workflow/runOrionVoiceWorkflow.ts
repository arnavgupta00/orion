import type { ConversationTurn } from '../types';
import type { GeneratedVoiceTurn } from './geminiTurnClient';

/** The transcript after Orion has validated it and prepared the current turn. */
export interface ReceivedVoiceTranscript {
  text: string;
  history: ConversationTurn[];
  controller: AbortController;
}

export interface OrionVoiceWorkflowStages {
  receiveTranscript(rawTranscript: string): ReceivedVoiceTranscript | null;
  generateGeminiTurn(transcript: ReceivedVoiceTranscript): Promise<GeneratedVoiceTurn>;
  commitConversationTurn(transcript: ReceivedVoiceTranscript, turn: GeneratedVoiceTurn): void;
  presentGeneratedTurn(turn: GeneratedVoiceTurn): Promise<void>;
}

/**
 * MASTER VOICE WORKFLOW
 *
 * This is the complete happy path for every spoken or suggested Orion turn.
 * Implementation details live behind the four named stages so the product flow
 * remains readable from one compact function.
 */
export async function runOrionVoiceWorkflow(
  rawTranscript: string,
  stages: OrionVoiceWorkflowStages,
): Promise<boolean> {
  const transcript = stages.receiveTranscript(rawTranscript);
  if (!transcript) return false;

  const generatedTurn = await stages.generateGeminiTurn(transcript);
  stages.commitConversationTurn(transcript, generatedTurn);
  await stages.presentGeneratedTurn(generatedTurn);

  return true;
}
