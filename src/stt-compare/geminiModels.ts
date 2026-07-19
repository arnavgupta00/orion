export const GEMINI_COMPARISON_MODELS = [
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
] as const;

export type GeminiComparisonModel = typeof GEMINI_COMPARISON_MODELS[number];
export type GeminiLiveModel = Extract<GeminiComparisonModel,
  'gemini-3.1-flash-live-preview' | 'gemini-2.5-flash-native-audio-preview-12-2025'>;
export type GeminiBatchModel = Exclude<GeminiComparisonModel, GeminiLiveModel>;

export const GEMINI_LIVE_MODELS: readonly GeminiLiveModel[] = [
  'gemini-3.1-flash-live-preview',
  'gemini-2.5-flash-native-audio-preview-12-2025',
];

export const GEMINI_BATCH_MODELS: readonly GeminiBatchModel[] = [
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
];

export function isGeminiComparisonModel(value: unknown): value is GeminiComparisonModel {
  return GEMINI_COMPARISON_MODELS.includes(value as GeminiComparisonModel);
}

export function isGeminiLiveModel(value: unknown): value is GeminiLiveModel {
  return GEMINI_LIVE_MODELS.includes(value as GeminiLiveModel);
}

export function createGeminiLiveSetup(
  model: GeminiLiveModel,
  transcriptionInstruction: string,
): Record<string, unknown> {
  return {
    model: `models/${model}`,
    generationConfig: {
      responseModalities: ['AUDIO'],
      temperature: 0,
      thinkingConfig: model === 'gemini-3.1-flash-live-preview'
        ? { thinkingLevel: 'minimal' }
        : { thinkingBudget: 0 },
    },
    systemInstruction: {
      parts: [{
        text: `${transcriptionInstruction}\nThis Live session is a transcription benchmark. Remain silent after the user finishes; do not answer the spoken content.`,
      }],
    },
    inputAudioTranscription: {},
    realtimeInputConfig: {
      automaticActivityDetection: { disabled: true },
    },
  };
}

export function geminiLiveSetupFieldMask(): string {
  return [
    'model',
    'generationConfig.responseModalities',
    'generationConfig.temperature',
    'generationConfig.thinkingConfig',
    'systemInstruction.parts',
    'inputAudioTranscription',
    'realtimeInputConfig.automaticActivityDetection',
  ].join(',');
}
