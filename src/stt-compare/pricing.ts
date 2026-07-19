import type { GeminiBatchModel, GeminiLiveModel } from './geminiModels';

export interface GeminiTranscriptionUsage {
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

interface BatchPricing {
  audioInputPerMillion: number;
  textInputPerMillion: number;
  textOutputPerMillion: number;
}

const BATCH_PRICING: Record<GeminiBatchModel, BatchPricing> = {
  'gemini-3-flash-preview': {
    audioInputPerMillion: 1.00,
    textInputPerMillion: 0.50,
    textOutputPerMillion: 3.00,
  },
  'gemini-3.1-flash-lite': {
    audioInputPerMillion: 0.50,
    textInputPerMillion: 0.25,
    textOutputPerMillion: 1.50,
  },
};

const LIVE_TEXT_OUTPUT_PER_MILLION: Record<GeminiLiveModel, number> = {
  'gemini-3.1-flash-live-preview': 4.50,
  'gemini-2.5-flash-native-audio-preview-12-2025': 2.00,
};

const GEMINI_BATCH_AUDIO_TOKENS_PER_SECOND = 32;
const GEMINI_LIVE_AUDIO_TOKENS_PER_SECOND = 25;

export function estimateGeminiBatchCost(
  model: GeminiBatchModel,
  durationMs: number,
  usage?: GeminiTranscriptionUsage,
): number {
  const pricing = BATCH_PRICING[model];
  const audioTokens = Math.ceil(durationMs / 1_000 * GEMINI_BATCH_AUDIO_TOKENS_PER_SECOND);
  const promptTokens = Math.max(audioTokens, usage?.promptTokens ?? audioTokens);
  const textInputTokens = Math.max(0, promptTokens - audioTokens);
  const outputTokens = Math.max(0, usage?.outputTokens ?? 0);
  return audioTokens * pricing.audioInputPerMillion / 1_000_000
    + textInputTokens * pricing.textInputPerMillion / 1_000_000
    + outputTokens * pricing.textOutputPerMillion / 1_000_000;
}

export function estimateGeminiLiveCost(
  model: GeminiLiveModel,
  durationMs: number,
  transcript: string,
): number {
  const outputTokens = Math.ceil(transcript.length / 4);
  const outputCost = outputTokens * LIVE_TEXT_OUTPUT_PER_MILLION[model] / 1_000_000;
  if (model === 'gemini-3.1-flash-live-preview') {
    return durationMs / 60_000 * 0.005 + outputCost;
  }
  const audioTokens = Math.ceil(durationMs / 1_000 * GEMINI_LIVE_AUDIO_TOKENS_PER_SECOND);
  return audioTokens * 3 / 1_000_000 + outputCost;
}

export function percentile(values: readonly number[], percentileValue: number): number | undefined {
  if (!values.length) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const index = Math.ceil((percentileValue / 100) * ordered.length) - 1;
  return ordered[Math.max(0, Math.min(ordered.length - 1, index))];
}
