import { describe, expect, it } from 'vitest';
import { buildComparisonListenUrl } from '../../../src/stt-compare/deepgramComparisonClient';
import { decodeLiveMessage, mergeLiveTranscript } from '../../../src/stt-compare/geminiLiveClient';
import {
  createGeminiLiveSetup,
  isGeminiLiveModel,
} from '../../../src/stt-compare/geminiModels';
import {
  estimateGeminiBatchCost,
  estimateGeminiLiveCost,
  percentile,
} from '../../../src/stt-compare/pricing';
import { hasAudiblePcm, pcm16ChunksToWav, pcmDurationMs } from '../../../src/voice/input/pcmWav';

describe('STT comparison inputs', () => {
  it('builds the required Flux V2 connection without V1-only parameters', () => {
    const url = new URL(buildComparisonListenUrl('flux', 48_000));
    expect(url.pathname).toBe('/v2/listen');
    expect(url.searchParams.get('model')).toBe('flux-general-en');
    expect(url.searchParams.get('sample_rate')).toBe('48000');
    expect(url.searchParams.has('language')).toBe(false);
    expect(url.searchParams.getAll('keyterm')).toContain('Orion');
  });

  it('builds a finalized Nova-3 V1 stream with matching PCM settings', () => {
    const url = new URL(buildComparisonListenUrl('nova', 44_100));
    expect(url.pathname).toBe('/v1/listen');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('language')).toBe('en-US');
    expect(url.searchParams.get('sample_rate')).toBe('44100');
    expect(url.searchParams.get('interim_results')).toBe('true');
  });

  it('wraps the exact PCM samples in a valid mono 16-bit WAV', async () => {
    const pcm = new Int16Array([0, 1200, -1200, 32_767]);
    const wav = pcm16ChunksToWav([pcm.buffer], 16_000);
    const view = new DataView(await wav.arrayBuffer());

    expect(wav.type).toBe('audio/wav');
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(pcm.byteLength);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(1200);
    expect(pcmDurationMs([pcm.buffer], 16_000)).toBeCloseTo(0.25);
  });

  it('downsamples direct-agent audio and distinguishes speech from silence', async () => {
    const samples = new Int16Array(48_000);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = Math.round(Math.sin(index / 20) * 2_000);
    }
    const wav = pcm16ChunksToWav([samples.buffer], 48_000, 16_000);
    const view = new DataView(await wav.arrayBuffer());
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(40, true)).toBe(32_000);
    expect(hasAudiblePcm([samples.buffer])).toBe(true);
    expect(hasAudiblePcm([new Int16Array(4_000).buffer])).toBe(false);
  });

  it('normalizes all Gemini model costs to the captured duration', () => {
    expect(estimateGeminiBatchCost(
      'gemini-3.1-flash-lite',
      60_000,
      { promptTokens: 2_000, outputTokens: 200 },
    ))
      .toBeCloseTo(0.00128, 6);
    expect(estimateGeminiBatchCost(
      'gemini-3-flash-preview',
      60_000,
      { promptTokens: 2_000, outputTokens: 200 },
    )).toBeCloseTo(0.00256, 6);
    expect(estimateGeminiLiveCost('gemini-3.1-flash-live-preview', 60_000, ''))
      .toBeCloseTo(0.005, 6);
    expect(estimateGeminiLiveCost('gemini-2.5-flash-native-audio-preview-12-2025', 60_000, ''))
      .toBeCloseTo(0.0045, 6);
  });

  it('builds constrained silent transcription setups for both Live models', () => {
    const setup = createGeminiLiveSetup('gemini-3.1-flash-live-preview', 'Transcribe exactly.');
    expect(setup.model).toBe('models/gemini-3.1-flash-live-preview');
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.realtimeInputConfig).toEqual({ automaticActivityDetection: { disabled: true } });
    expect(isGeminiLiveModel('gemini-2.5-flash-native-audio-preview-12-2025')).toBe(true);
    expect(isGeminiLiveModel('gemini-3.1-flash-lite')).toBe(false);
  });

  it('merges incremental and corrected Live transcript fragments without duplicating text', () => {
    expect(mergeLiveTranscript('How are', 'How are you doing?')).toBe('How are you doing?');
    expect(mergeLiveTranscript('open the or', 'orb field')).toBe('open the orb field');
    expect(mergeLiveTranscript('Arnav', 'Gupta')).toBe('Arnav Gupta');
  });

  it('decodes the binary JSON frames returned by Gemini Live', async () => {
    const payload = JSON.stringify({ setupComplete: {} });
    expect(await decodeLiveMessage(new TextEncoder().encode(payload).buffer))
      .toEqual({ setupComplete: {} });
    expect(await decodeLiveMessage(new Blob([payload])))
      .toEqual({ setupComplete: {} });
  });

  it('reports nearest-rank latency percentiles', () => {
    expect(percentile([1_000, 100, 300, 200], 50)).toBe(200);
    expect(percentile([1_000, 100, 300, 200], 95)).toBe(1_000);
    expect(percentile([], 50)).toBeUndefined();
  });
});
