/**
 * WAV file I/O utilities for Node.js CLI
 * Parses and creates WAV files without browser APIs
 */

import { readFileSync, writeFileSync } from 'fs';

export interface WavData {
  samples: Float32Array;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
}

/**
 * Parse a WAV file and return audio samples
 */
export function parseWavFile(filePath: string): WavData {
  const buffer = readFileSync(filePath);
  return parseWavBuffer(buffer);
}

/**
 * Parse WAV data from a Buffer
 */
export function parseWavBuffer(buffer: Buffer): WavData {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // Verify RIFF header
  const riff = String.fromCharCode(buffer[0], buffer[1], buffer[2], buffer[3]);
  if (riff !== 'RIFF') {
    throw new Error('Not a valid WAV file: missing RIFF header');
  }

  const wave = String.fromCharCode(buffer[8], buffer[9], buffer[10], buffer[11]);
  if (wave !== 'WAVE') {
    throw new Error('Not a valid WAV file: missing WAVE format');
  }

  // Find fmt chunk
  let offset = 12;
  let fmtFound = false;
  let numChannels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let audioFormat = 0;

  while (offset < buffer.length - 8) {
    const chunkId = String.fromCharCode(buffer[offset], buffer[offset + 1], buffer[offset + 2], buffer[offset + 3]);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      audioFormat = view.getUint16(offset + 8, true);
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
      fmtFound = true;
    }

    if (chunkId === 'data') {
      if (!fmtFound) {
        throw new Error('WAV file missing fmt chunk before data');
      }

      // Only support PCM (format 1) and IEEE float (format 3)
      if (audioFormat !== 1 && audioFormat !== 3) {
        throw new Error(`Unsupported WAV format: ${audioFormat} (only PCM and IEEE float supported)`);
      }

      const dataOffset = offset + 8;
      const bytesPerSample = bitsPerSample / 8;
      const numSamples = Math.floor(chunkSize / bytesPerSample / numChannels);

      // Read samples and convert to Float32
      const samples = new Float32Array(numSamples);

      for (let i = 0; i < numSamples; i++) {
        let sampleValue = 0;

        // Mix all channels to mono
        for (let ch = 0; ch < numChannels; ch++) {
          const sampleOffset = dataOffset + (i * numChannels + ch) * bytesPerSample;

          if (audioFormat === 3) {
            // IEEE float
            if (bitsPerSample === 32) {
              sampleValue += view.getFloat32(sampleOffset, true);
            } else if (bitsPerSample === 64) {
              sampleValue += view.getFloat64(sampleOffset, true);
            }
          } else {
            // PCM
            if (bitsPerSample === 8) {
              // 8-bit is unsigned, centered at 128
              sampleValue += (buffer[sampleOffset] - 128) / 128;
            } else if (bitsPerSample === 16) {
              sampleValue += view.getInt16(sampleOffset, true) / 32768;
            } else if (bitsPerSample === 24) {
              // 24-bit little-endian
              const b0 = buffer[sampleOffset];
              const b1 = buffer[sampleOffset + 1];
              const b2 = buffer[sampleOffset + 2];
              let value = (b2 << 16) | (b1 << 8) | b0;
              if (value >= 0x800000) value -= 0x1000000;
              sampleValue += value / 8388608;
            } else if (bitsPerSample === 32) {
              sampleValue += view.getInt32(sampleOffset, true) / 2147483648;
            }
          }
        }

        // Average channels for mono
        samples[i] = sampleValue / numChannels;
      }

      return {
        samples,
        sampleRate,
        numChannels,
        bitsPerSample,
      };
    }

    offset += 8 + chunkSize;
    // Chunks are word-aligned
    if (chunkSize % 2 !== 0) offset++;
  }

  throw new Error('WAV file missing data chunk');
}

/**
 * Write Float32Array samples to a WAV file
 */
export function writeWavFile(
  filePath: string,
  samples: Float32Array,
  sampleRate: number
): void {
  const wavData = createWavBuffer(samples, sampleRate);
  writeFileSync(filePath, wavData);
}

/**
 * Create WAV buffer from samples (same as src/lib/wav.ts createWAV)
 */
export function createWavBuffer(
  samples: Float32Array,
  sampleRate: number,
  numChannels = 1,
  bitsPerSample = 16
): Buffer {
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const fileSize = 44 + dataSize;

  const buffer = Buffer.alloc(fileSize);
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  // RIFF header
  buffer.write('RIFF', 0);
  view.setUint32(4, fileSize - 8, true);
  buffer.write('WAVE', 8);

  // fmt chunk
  buffer.write('fmt ', 12);
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);  // PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data chunk
  buffer.write('data', 36);
  view.setUint32(40, dataSize, true);

  // Write samples
  const offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const sample = Math.max(-1, Math.min(1, samples[i]));
    const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
    view.setInt16(offset + i * 2, int16, true);
  }

  return buffer;
}
