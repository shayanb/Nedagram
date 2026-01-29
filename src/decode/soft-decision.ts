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

import { fft, magnitude } from '../lib/fft';
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
 * @returns Soft detection result with confidence for each tone
 */
export function detectToneSoft(
  samples: Float32Array,
  sampleRate: number,
  frequencyOffset: number = 0
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
  };
}

/**
 * Batch detect multiple symbols with soft output
 *
 * @param samples - Audio samples containing multiple symbols
 * @param sampleRate - Audio sample rate
 * @param symbolDuration - Duration of each symbol in samples
 * @param guardDuration - Guard interval in samples (skipped)
 * @param frequencyOffset - Optional frequency offset compensation
 * @returns Array of soft detection results
 */
export function detectSymbolsSoft(
  samples: Float32Array,
  sampleRate: number,
  symbolDuration: number,
  guardDuration: number,
  frequencyOffset: number = 0
): SoftDetectionResult[] {
  const totalSymbolLength = symbolDuration + guardDuration;
  const numSymbols = Math.floor(samples.length / totalSymbolLength);
  const results: SoftDetectionResult[] = [];

  for (let i = 0; i < numSymbols; i++) {
    const start = i * totalSymbolLength;
    const symbolSamples = samples.slice(start, start + symbolDuration);

    results.push(detectToneSoft(symbolSamples, sampleRate, frequencyOffset));
  }

  return results;
}

/**
 * Convert soft symbols to hard decisions (for compatibility)
 */
export function softToHard(softResults: SoftDetectionResult[]): number[] {
  return softResults.map(r => r.hardDecision);
}

/**
 * Extract soft values matrix for Viterbi decoder
 * Returns array of soft symbol arrays
 */
export function extractSoftMatrix(softResults: SoftDetectionResult[]): SoftSymbol[] {
  return softResults.map(r => r.softValues);
}

/**
 * Calculate average confidence from soft results
 */
export function averageConfidence(softResults: SoftDetectionResult[]): number {
  if (softResults.length === 0) return 0;
  const sum = softResults.reduce((acc, r) => acc + r.confidence, 0);
  return sum / softResults.length;
}

/**
 * Measure signal quality from soft results
 * Returns 0-1 score indicating how "clean" the signal is
 */
export function measureSignalQuality(softResults: SoftDetectionResult[]): number {
  if (softResults.length === 0) return 0;

  // High quality: one tone is clearly dominant (high confidence)
  // Low quality: multiple tones have similar magnitudes

  let qualitySum = 0;

  for (const result of softResults) {
    // Calculate entropy-like measure
    // High entropy (uniform distribution) = low quality
    // Low entropy (one dominant) = high quality

    const soft = result.softValues;
    const total = soft.reduce((a, b) => a + b, 0);

    if (total === 0) {
      qualitySum += 0;
      continue;
    }

    // Find max and calculate dominance
    let maxVal = 0;
    for (let i = 0; i < soft.length; i++) {
      maxVal = Math.max(maxVal, soft[i]);
    }

    // Dominance: how much the max stands out
    const dominance = maxVal / total * soft.length;
    qualitySum += Math.min(1, dominance - 1); // 0 when uniform, 1 when single peak
  }

  return qualitySum / softResults.length;
}

/**
 * Soft value utilities for Viterbi decoder
 */
export const SoftUtils = {
  /**
   * Convert soft value to log-likelihood ratio (LLR)
   * Used by some soft-decision decoders
   */
  toLogLikelihood(soft: number): number {
    // Avoid division by zero
    const p = Math.max(0.001, Math.min(0.999, soft / 255));
    return Math.log(p / (1 - p));
  },

  /**
   * Convert log-likelihood back to soft value
   */
  fromLogLikelihood(llr: number): number {
    const p = 1 / (1 + Math.exp(-llr));
    return Math.round(p * 255);
  },

  /**
   * Combine two soft values (for repeated measurements)
   */
  combine(a: number, b: number): number {
    // Geometric mean preserves soft-decision properties better
    return Math.round(Math.sqrt(a * b));
  },

  /**
   * Invert soft value (for "not this symbol")
   */
  invert(soft: number): number {
    return 255 - soft;
  },

  /**
   * Check if soft value indicates high confidence
   */
  isConfident(soft: number, threshold: number = 200): boolean {
    return soft >= threshold;
  },

  /**
   * Check if soft value indicates uncertainty
   */
  isUncertain(soft: number, threshold: number = 50): boolean {
    return soft > 127 - threshold && soft < 127 + threshold;
  },
};
