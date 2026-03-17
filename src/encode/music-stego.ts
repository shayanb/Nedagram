/**
 * Music Steganography Encoder
 *
 * Generates a Nedagram transmission mixed into cover music.
 * Replaces the chirp preamble with MFSK pilot tones and
 * adaptively scales tone amplitude based on music energy.
 */
import { AUDIO, TONE_FREQUENCIES } from '../utils/constants';
import { generatePilotPreamble } from './pilot';
import { modulateBytes, calculateSymbolCount } from './modulate';

export interface MusicStegoOptions {
  /** Tone-to-music ratio in dB (negative = tones quieter than music). Default: -6 */
  tmrDb?: number;
  /** Offset in seconds into the music where tones start. Default: 0.5 */
  startOffsetSec?: number;
}

/**
 * Calculate RMS energy of a sample buffer
 */
function rms(samples: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

/**
 * Generate a music-steganography transmission
 *
 * Takes the FEC-encoded frames (same as generateTransmission) and
 * cover music audio, returns the mixed audio.
 *
 * @param encodedFrames - FEC-encoded, interleaved frames [header, ...data]
 * @param musicSamples - Cover music audio (mono, at AUDIO.SAMPLE_RATE)
 * @param sampleRate - Sample rate (must match musicSamples)
 * @param options - Steganography options
 * @returns Mixed audio (music + embedded tones)
 */
export function generateMusicTransmission(
  encodedFrames: Uint8Array[],
  musicSamples: Float32Array,
  sampleRate: number,
  options?: MusicStegoOptions,
): Float32Array {
  const tmrDb = options?.tmrDb ?? -6;
  const startOffsetSec = options?.startOffsetSec ?? 0.5;
  const startOffsetSamples = Math.floor(startOffsetSec * sampleRate);

  // 1. Generate the raw tone signal (pilot preamble + data)
  const toneParts: Float32Array[] = [];

  // Pilot preamble (replaces chirp + calibration + sync)
  toneParts.push(generatePilotPreamble(sampleRate));

  // Determine header repetition (same logic as generateTransmission)
  const numDataFrames = encodedFrames.length - 1;
  const repeatHeader = numDataFrames > 1;

  // Header frame
  toneParts.push(modulateBytes(encodedFrames[0], sampleRate));
  if (repeatHeader) {
    toneParts.push(modulateBytes(encodedFrames[0], sampleRate));
  }

  // Data frames
  for (let i = 1; i < encodedFrames.length; i++) {
    toneParts.push(modulateBytes(encodedFrames[i], sampleRate));
  }

  // End marker (sync pattern)
  const endMarkerSamples = generateEndMarker(sampleRate);
  toneParts.push(endMarkerSamples);

  // Concatenate all tone parts
  const totalToneSamples = toneParts.reduce((sum, p) => sum + p.length, 0);
  const toneSignal = new Float32Array(totalToneSamples);
  let offset = 0;
  for (const part of toneParts) {
    toneSignal.set(part, offset);
    offset += part.length;
  }

  // 2. Calculate scaling factor based on TMR
  const musicRms = rms(musicSamples);
  const toneRms = rms(toneSignal);

  // TMR = 20 * log10(toneRms_scaled / musicRms)
  // toneRms_scaled = musicRms * 10^(tmrDb/20)
  const targetToneRms = musicRms * Math.pow(10, tmrDb / 20);
  const scaleFactor = toneRms > 0 ? targetToneRms / toneRms : 0;

  // 3. Mix tones into music
  const totalOutputSamples = Math.max(
    musicSamples.length,
    startOffsetSamples + toneSignal.length
  );
  const output = new Float32Array(totalOutputSamples);

  // Copy music
  output.set(musicSamples.subarray(0, Math.min(musicSamples.length, totalOutputSamples)));

  // Add scaled tones
  for (let i = 0; i < toneSignal.length; i++) {
    const outIdx = startOffsetSamples + i;
    if (outIdx < totalOutputSamples) {
      output[outIdx] += toneSignal[i] * scaleFactor;
      // Soft clip to prevent distortion
      if (output[outIdx] > 1) output[outIdx] = 1;
      else if (output[outIdx] < -1) output[outIdx] = -1;
    }
  }

  return output;
}

/**
 * Generate end marker (sync pattern tones)
 */
function generateEndMarker(sampleRate: number): Float32Array {
  const symbolDurationMs = AUDIO.SYMBOL_DURATION_MS;
  const guardMs = AUDIO.GUARD_INTERVAL_MS;
  const symbolSamples = Math.floor((symbolDurationMs / 1000) * sampleRate);
  const guardSamples = Math.floor((guardMs / 1000) * sampleRate);

  const pattern = AUDIO.SYNC_PATTERN;
  const audio = new Float32Array(pattern.length * symbolSamples);

  for (let i = 0; i < pattern.length; i++) {
    const freq = TONE_FREQUENCIES[pattern[i]];
    const off = i * symbolSamples;

    for (let s = 0; s < symbolSamples; s++) {
      let sample = Math.sin(2 * Math.PI * freq * s / sampleRate) * 0.85;
      if (guardSamples > 0) {
        if (s < guardSamples) {
          sample *= 0.5 * (1 - Math.cos(Math.PI * s / guardSamples));
        } else if (s >= symbolSamples - guardSamples) {
          sample *= 0.5 * (1 - Math.cos(Math.PI * (symbolSamples - s) / guardSamples));
        }
      }
      audio[off + s] = sample;
    }
  }

  return audio;
}

/**
 * Estimate required music duration for a given payload
 */
export function estimateMusicDuration(
  totalEncodedBytes: number,
  sampleRate: number,
  startOffsetSec: number = 0.5,
): number {
  // Pilot: 32 symbols
  const pilotSymbols = 32;
  // Data symbols
  const dataSymbols = calculateSymbolCount(totalEncodedBytes);
  // End marker: 8 symbols
  const endSymbols = AUDIO.SYNC_PATTERN.length;

  const totalSymbols = pilotSymbols + dataSymbols + endSymbols;
  const symbolDurationSec = (AUDIO.SYMBOL_DURATION_MS + AUDIO.GUARD_INTERVAL_MS) / 1000;

  return startOffsetSec + totalSymbols * symbolDurationSec;
}
