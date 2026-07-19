export const ORION_SPEECH_MARKER = '<<<ORION_SPEECH>>>';
export const ORION_SCREEN_MARKER = '<<<ORION_SCREEN>>>';
export const ORION_END_MARKER = '<<<ORION_END>>>';

export const MAX_SPOKEN_TEXT = 650;
export const MAX_SCREEN_TEXT = 12_000;

export interface DualSurfaceResponse {
  spokenText: string;
  screenText: string;
}

export interface DualSurfaceEnvelopeCallbacks {
  onSpeechDelta(text: string): void;
  onScreenDelta(text: string): void;
}

type EnvelopePhase = 'seeking-speech' | 'speech' | 'screen' | 'done';

/** Incrementally separates Gemini's voice-first response envelope without leaking markers. */
export class DualSurfaceEnvelopeParser {
  private phase: EnvelopePhase = 'seeking-speech';
  private pending = '';
  private raw = '';
  private spokenText = '';
  private screenText = '';
  private sawSpeechMarker = false;
  private sawScreenMarker = false;

  constructor(private readonly callbacks: DualSurfaceEnvelopeCallbacks) {}

  push(chunk: string): void {
    if (!chunk || this.phase === 'done') return;
    this.raw = (this.raw + chunk).slice(0, MAX_SCREEN_TEXT + MAX_SPOKEN_TEXT + 512);
    this.pending += chunk;
    this.drain();
  }

  finish(allowFallback = true): DualSurfaceResponse {
    if (this.phase === 'speech') this.emitSpeech(this.pending);
    if (this.phase === 'screen') this.emitScreen(this.pending);
    this.pending = '';

    if (allowFallback) this.repairMissingChannels();
    this.phase = 'done';
    return { spokenText: this.spokenText.trim(), screenText: this.screenText.trim() };
  }

  snapshot(): DualSurfaceResponse {
    return { spokenText: this.spokenText.trim(), screenText: this.screenText.trim() };
  }

  private drain(): void {
    while (this.pending && this.phase !== 'done') {
      if (this.phase === 'seeking-speech') {
        const markerIndex = this.pending.indexOf(ORION_SPEECH_MARKER);
        if (markerIndex >= 0) {
          this.pending = this.pending.slice(markerIndex + ORION_SPEECH_MARKER.length);
          this.sawSpeechMarker = true;
          this.phase = 'speech';
          continue;
        }
        this.pending = retainPossibleMarker(this.pending, ORION_SPEECH_MARKER);
        return;
      }

      if (this.phase === 'speech') {
        const markerIndex = this.pending.indexOf(ORION_SCREEN_MARKER);
        if (markerIndex >= 0) {
          this.emitSpeech(this.pending.slice(0, markerIndex));
          this.pending = this.pending.slice(markerIndex + ORION_SCREEN_MARKER.length);
          this.sawScreenMarker = true;
          this.phase = 'screen';
          continue;
        }
        const retained = retainPossibleMarker(this.pending, ORION_SCREEN_MARKER);
        this.emitSpeech(this.pending.slice(0, this.pending.length - retained.length));
        this.pending = retained;
        return;
      }

      const markerIndex = this.pending.indexOf(ORION_END_MARKER);
      if (markerIndex >= 0) {
        this.emitScreen(this.pending.slice(0, markerIndex));
        this.pending = '';
        this.phase = 'done';
        return;
      }
      const retained = retainPossibleMarker(this.pending, ORION_END_MARKER);
      this.emitScreen(this.pending.slice(0, this.pending.length - retained.length));
      this.pending = retained;
      return;
    }
  }

  private emitSpeech(text: string): void {
    const available = MAX_SPOKEN_TEXT - this.spokenText.length;
    if (available <= 0 || !text) return;
    const delta = text.slice(0, available);
    this.spokenText += delta;
    this.callbacks.onSpeechDelta(delta);
  }

  private emitScreen(text: string): void {
    const available = MAX_SCREEN_TEXT - this.screenText.length;
    if (available <= 0 || !text) return;
    const delta = text.slice(0, available);
    this.screenText += delta;
    this.callbacks.onScreenDelta(delta);
  }

  private repairMissingChannels(): void {
    const cleaned = stripEnvelopeMarkers(this.raw).trim().slice(0, MAX_SCREEN_TEXT);
    if (!this.screenText.trim()) {
      const fallback = cleaned || this.spokenText.trim();
      if (fallback) this.emitScreen(fallback.slice(0, MAX_SCREEN_TEXT));
    }
    if (!this.spokenText.trim() && this.screenText.trim() && !(this.sawSpeechMarker && this.sawScreenMarker)) {
      this.emitSpeech(spokenFallback(this.screenText));
    }
  }
}

export function formatAssistantHistory(turn: DualSurfaceResponse): string {
  return `${ORION_SPEECH_MARKER}\n${turn.spokenText}\n${ORION_SCREEN_MARKER}\n${turn.screenText}\n${ORION_END_MARKER}`;
}

function retainPossibleMarker(text: string, marker: string): string {
  const maximum = Math.min(text.length, marker.length - 1);
  for (let length = maximum; length > 0; length -= 1) {
    const suffix = text.slice(-length);
    if (marker.startsWith(suffix)) return suffix;
  }
  return '';
}

function stripEnvelopeMarkers(text: string): string {
  return text
    .split(ORION_SPEECH_MARKER).join('')
    .split(ORION_SCREEN_MARKER).join('\n')
    .split(ORION_END_MARKER).join('')
    .trim();
}

function spokenFallback(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_`~-]+/g, ' ')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = plain.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? [];
  return sentences.slice(0, 2).map((sentence) => sentence.trim()).join(' ').slice(0, 520);
}
