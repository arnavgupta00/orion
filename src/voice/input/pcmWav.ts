const WAV_HEADER_BYTES = 44;

/** Wrap Orion's mono PCM16 capture in a WAV, optionally downsampling first. */
export function pcm16ChunksToWav(
  chunks: readonly ArrayBuffer[],
  inputSampleRate: number,
  outputSampleRate = inputSampleRate,
): Blob {
  const samples = joinPcm16(chunks);
  const pcm = outputSampleRate < inputSampleRate
    ? downsamplePcm16(samples, inputSampleRate, outputSampleRate)
    : samples;
  const pcmBytes = pcm.byteLength;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + pcmBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + pcmBytes, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, Math.round(outputSampleRate), true);
  view.setUint32(28, Math.round(outputSampleRate) * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, pcmBytes, true);
  new Int16Array(buffer, WAV_HEADER_BYTES).set(pcm);
  return new Blob([buffer], { type: 'audio/wav' });
}

export function pcmDurationMs(chunks: readonly ArrayBuffer[], sampleRate: number): number {
  const samples = chunks.reduce((total, chunk) => total + Math.floor(chunk.byteLength / 2), 0);
  return samples / Math.max(1, sampleRate) * 1_000;
}

/** Reject only captures that are effectively digital silence. */
export function hasAudiblePcm(chunks: readonly ArrayBuffer[]): boolean {
  let samples = 0;
  let squareSum = 0;
  let peak = 0;
  for (const chunk of chunks) {
    const pcm = new Int16Array(chunk);
    for (let index = 0; index < pcm.length; index += 4) {
      const value = (pcm[index] ?? 0) / 0x8000;
      squareSum += value * value;
      peak = Math.max(peak, Math.abs(value));
      samples += 1;
    }
  }
  const rms = Math.sqrt(squareSum / Math.max(1, samples));
  return peak >= 0.012 || rms >= 0.002;
}

function joinPcm16(chunks: readonly ArrayBuffer[]): Int16Array {
  const sampleCount = chunks.reduce((total, chunk) => total + Math.floor(chunk.byteLength / 2), 0);
  const joined = new Int16Array(sampleCount);
  let offset = 0;
  for (const chunk of chunks) {
    const pcm = new Int16Array(chunk);
    joined.set(pcm, offset);
    offset += pcm.length;
  }
  return joined;
}

function downsamplePcm16(input: Int16Array, inputRate: number, outputRate: number): Int16Array {
  if (!input.length || outputRate >= inputRate) return input;
  const ratio = inputRate / outputRate;
  const output = new Int16Array(Math.max(1, Math.floor(input.length / ratio)));
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((outputIndex + 1) * ratio)));
    let sum = 0;
    for (let inputIndex = start; inputIndex < end; inputIndex += 1) sum += input[inputIndex] ?? 0;
    output[outputIndex] = Math.round(sum / (end - start));
  }
  return output;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let index = 0; index < text.length; index += 1) {
    view.setUint8(offset + index, text.charCodeAt(index));
  }
}
