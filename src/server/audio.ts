import { Buffer } from "node:buffer";

export const PCM_SAMPLE_RATE = 16_000;
export const PCM_BYTES_PER_SAMPLE = 2;

export function pcmSecondsToBytes(seconds: number): number {
  return Math.max(1, Math.floor(seconds * PCM_SAMPLE_RATE * PCM_BYTES_PER_SAMPLE));
}

export function trimChunksToBytes(chunks: Buffer[], maxBytes: number): Buffer[] {
  let total = 0;
  const trimmed: Buffer[] = [];

  for (let index = chunks.length - 1; index >= 0; index -= 1) {
    const chunk = chunks[index];

    if (total >= maxBytes) {
      break;
    }

    if (total + chunk.length <= maxBytes) {
      trimmed.unshift(chunk);
      total += chunk.length;
      continue;
    }

    const remainder = maxBytes - total;
    trimmed.unshift(chunk.subarray(chunk.length - remainder));
    total += remainder;
  }

  return trimmed;
}

export function pcmToWavBuffer(pcm: Buffer, sampleRate = PCM_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  const dataSize = pcm.length;
  const byteRate = sampleRate * PCM_BYTES_PER_SAMPLE;

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(PCM_BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, pcm]);
}
