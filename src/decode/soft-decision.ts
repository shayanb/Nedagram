/**
 * Soft-Decision Types and Detection for Nedagram v3
 *
 * Soft-decision decoding provides confidence values for each possible symbol,
 * allowing the Viterbi decoder to make better decisions than hard-decision
 * (single best guess) decoding.
 *
 * Soft values are 8-bit unsigned integers (0-255):
 * - 0 = very unlikely
 * - 127 = uncertain
 * - 255 = very likely
 */

import { fft, magnitude, findPeakFrequency } from '../lib/fft';
import { AUDIO, TONE_FREQUENCIES } from '../utils/constants';

/**
 * Soft symbol: confidence values for each possible tone
 * Array length equals number of tones (4 for phone, 16 for wideband)
 */
export type SoftSymbol = Uint8Array;

/**
 * Result of soft-decision tone detection
 */
export interface SoftDetectionResult {
  /** Confidence values for each tone (0-255) */
  softValues: SoftSymbol;
  /** Best (most likely) tone index */
  hardDecision: number;
  /** Confidence in hard decision (0-1) */
  confidence: number;
  /** Raw magnitudes for debugging */
  magnitudes?: number[];
  /** Peak frequency measured in each tone's band (Hz) */
  peakFrequencies?: number[];
}

/**
 * Convert raw magnitude to soft value (0-255)
 * Uses linear scaling with saturation
 */
function magnitudeToSoft(mag: number, maxMag: number, minMag: number): number {
  if (maxMag <= minMag) return 127; // Uncertain

  // Normalize to 0-1 range
  const normalized = (mag - minMag) / (maxMag - minMag);

  // Scale to 0-255
  return Math.round(Math.max(0, Math.min(255, normalized * 255)));
}

/**
 * Detect tone with soft-decision output
 *
 * Returns confidence values for ALL tones, allowing the Viterbi decoder
 * to consider multiple hypotheses.
 *
 * @param samples - Audio samples for one symbol period
 * @param sampleRate - Audio sample rate
 * @param frequencyOffset - Optional frequency offset compensation (Hz)
 * @param toneBiases - Optional per-tone baseline magnitudes to subtract (interference compensation)
 * @returns Soft detection result with confidence for each tone
 */
export function detectToneSoft(
  samples: Float32Array,
  sampleRate: number,
  frequencyOffset: number = 0,
  toneBiases?: Float32Array
): SoftDetectionResult {
  // Compute FFT and magnitudes
  const fftResult = fft(samples);
  const mags = magnitude(fftResult);

  const fftSize = mags.length * 2;
  const binWidth = sampleRate / fftSize;
  const halfSpacing = AUDIO.TONE_SPACING / 2;

  const numTones = TONE_FREQUENCIES.length;
  const toneMagnitudes = new Float32Array(numTones);

  // Measure magnitude at each tone frequency
  for (let t = 0; t < numTones; t++) {
    // Apply frequency offset compensation
    const freq = TONE_FREQUENCIES[t] + frequencyOffset;
    const minBin = Math.max(0, Math.floor((freq - halfSpacing) / binWidth));
    const maxBin = Math.min(mags.length - 1, Math.ceil((freq + halfSpacing) / binWidth));

    // Sum magnitudes in the tone's frequency band
    // Using sum instead of max provides smoother soft values
    let toneMag = 0;
    let peakMag = 0;
    for (let i = minBin; i <= maxBin; i++) {
      toneMag += mags[i];
      peakMag = Math.max(peakMag, mags[i]);
    }

    // Combine sum and peak for robust measurement
    toneMagnitudes[t] = toneMag * 0.3 + peakMag * 0.7;
  }

  // Apply interference compensation: divide by baseline magnitudes (spectral whitening)
  // Division normalizes each tone by its noise floor, making comparisons fair even with
  // strong narrowband interference (e.g., 1800 Hz constant tone from phone codecs).
  // This is much more effective than subtraction when interference >> signal.
  if (toneBiases) {
    for (let t = 0; t < numTones; t++) {
      toneMagnitudes[t] = toneBiases[t] > 1 ? toneMagnitudes[t] / toneBiases[t] : toneMagnitudes[t];
    }
  }

  // Measure peak frequency in each tone's band
  const peakFrequencies: number[] = new Array(numTones);
  for (let t = 0; t < numTones; t++) {
    const freq = TONE_FREQUENCIES[t] + frequencyOffset;
    const peak = findPeakFrequency(mags, sampleRate, freq - halfSpacing, freq + halfSpacing);
    peakFrequencies[t] = peak.frequency;
  }

  // Find min and max for normalization
  let minMag = Infinity;
  let maxMag = -Infinity;
  for (let t = 0; t < numTones; t++) {
    minMag = Math.min(minMag, toneMagnitudes[t]);
    maxMag = Math.max(maxMag, toneMagnitudes[t]);
  }

  // Convert to soft values
  const softValues = new Uint8Array(numTones);
  let hardDecision = 0;
  let hardMagnitude = toneMagnitudes[0];

  for (let t = 0; t < numTones; t++) {
    softValues[t] = magnitudeToSoft(toneMagnitudes[t], maxMag, minMag);

    if (toneMagnitudes[t] > hardMagnitude) {
      hardMagnitude = toneMagnitudes[t];
      hardDecision = t;
    }
  }

  // Calculate confidence: ratio of best to second-best
  let secondBest = 0;
  for (let t = 0; t < numTones; t++) {
    if (t !== hardDecision && toneMagnitudes[t] > secondBest) {
      secondBest = toneMagnitudes[t];
    }
  }

  const confidence = secondBest > 0
    ? Math.min(1, (hardMagnitude - secondBest) / hardMagnitude)
    : 1;

  return {
    softValues,
    hardDecision,
    confidence,
    magnitudes: Array.from(toneMagnitudes),
    peakFrequencies,
  };
}

/**
 * Convert soft symbol detections to soft bit values for Viterbi decoder.
 *
 * For each symbol, compute P(bit_k = 1) by summing soft values of all tones
 * where bit k is 1, divided by the total soft value sum. This produces
 * per-bit probabilities (0.0 = definitely 0, 1.0 = definitely 1) that the
 * Viterbi decoder uses for soft-decision decoding (~2-3 dB gain over hard).
 *
 * Phone mode (4 tones, 2 bits/symbol):
 *   Tone 0 = 00, Tone 1 = 01, Tone 2 = 10, Tone 3 = 11
 *   P(MSB=1) = (soft[2] + soft[3]) / total
 *   P(LSB=1) = (soft[1] + soft[3]) / total
 *
 * Wideband mode (16 tones, 4 bits/symbol):
 *   Tone index = b3 b2 b1 b0 (MSB first)
 *   P(bit_k=1) = sum of soft[t] for all t where bit k of t is 1
 *
 * @param softResults - Array of soft detection results (one per symbol)
 * @param bitsPerSymbol - Number of bits per symbol (2 for phone, 4 for wideband)
 * @returns Array of soft bit values (0.0-1.0), MSB first per symbol
 */
export function softSymbolsToSoftBits(
  softResults: SoftDetectionResult[],
  bitsPerSymbol: number
): number[] {
  const softBits: number[] = [];
  const numTones = 1 << bitsPerSymbol; // 4 for phone, 16 for wideband

  for (const result of softResults) {
    const soft = result.softValues;
    const toneCount = Math.min(soft.length, numTones);

    // Calculate total confidence for normalization
    let total = 0;
    for (let t = 0; t < toneCount; t++) {
      total += soft[t];
    }

    // If total is 0 (silence/no signal), fall back to hard decision
    if (total === 0) {
      const hard = result.hardDecision;
      for (let b = bitsPerSymbol - 1; b >= 0; b--) {
        softBits.push((hard >> b) & 1 ? 1.0 : 0.0);
      }
      continue;
    }

    // For each bit position (MSB first, matching symbolsToBytes packing)
    for (let b = bitsPerSymbol - 1; b >= 0; b--) {
      // P(bit_b = 1) = sum of soft[t] for all tones where bit b is 1
      let pOne = 0;
      for (let t = 0; t < toneCount; t++) {
        if ((t >> b) & 1) {
          pOne += soft[t];
        }
      }
      softBits.push(pOne / total);
    }
  }

  return softBits;
}
