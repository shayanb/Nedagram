/**
 * Frequency Offset Tracking for Nedagram v3
 *
 * Estimates frequency offset during calibration tones and provides
 * compensation for symbol detection.
 *
 * Common causes of frequency offset:
 * - Audio codec resampling
 * - Sample rate mismatch
 * - Doppler effect (moving devices)
 * - Analog path variations
 */

import { fft, magnitude, findPeakFrequency } from '../lib/fft';
import { AUDIO, TONE_FREQUENCIES } from '../utils/constants';

export interface FrequencyOffsetResult {
  /** Estimated offset in Hz (positive = received frequencies are higher) */
  offsetHz: number;
  /** Confidence in the estimate (0-1) */
  confidence: number;
  /** Individual measurements for each calibration tone */
  measurements: ToneMeasurement[];
}

export interface ToneMeasurement {
  expectedHz: number;
  measuredHz: number;
  errorHz: number;
  magnitude: number;
}

/**
 * Frequency Offset Tracker
 *
 * Maintains state for frequency offset estimation and compensation.
 */
export class FrequencyOffsetTracker {
  private offsetHz: number = 0;
  private confidence: number = 0;
  private measurements: ToneMeasurement[] = [];

  // Configuration
  private readonly maxOffsetHz: number;
  private readonly searchWindowHz: number = 100; // Search ±100 Hz around expected

  constructor(maxOffsetHz: number = 30) {
    this.maxOffsetHz = maxOffsetHz;
  }

  /**
   * Estimate frequency offset from calibration tone samples
   *
   * @param calibrationSamples - Audio samples containing calibration tones
   * @param sampleRate - Audio sample rate
   * @param expectedTones - Expected calibration tone indices
   * @param symbolDuration - Duration of each symbol in samples
   * @returns Frequency offset estimation result
   */
  estimateOffset(
    calibrationSamples: Float32Array,
    sampleRate: number,
    expectedTones: number[],
    symbolDuration: number
  ): FrequencyOffsetResult {
    this.measurements = [];
    let totalError = 0;
    let totalWeight = 0;

    for (let i = 0; i < expectedTones.length; i++) {
      const toneIndex = expectedTones[i];
      const expectedFreq = TONE_FREQUENCIES[toneIndex];

      // Extract samples for this tone
      const startSample = i * symbolDuration;
      const endSample = Math.min(startSample + symbolDuration, calibrationSamples.length);

      if (endSample - startSample < symbolDuration * 0.5) {
        // Not enough samples
        continue;
      }

      const toneSamples = calibrationSamples.slice(startSample, endSample);

      // Find actual peak frequency
      const fftResult = fft(toneSamples);
      const magnitudes = magnitude(fftResult);

      const peak = findPeakFrequency(
        magnitudes,
        sampleRate,
        expectedFreq - this.searchWindowHz,
        expectedFreq + this.searchWindowHz
      );

      const errorHz = peak.frequency - expectedFreq;

      this.measurements.push({
        expectedHz: expectedFreq,
        measuredHz: peak.frequency,
        errorHz: errorHz,
        magnitude: peak.magnitude,
      });

      // Weight by magnitude (stronger signals give more reliable measurements)
      const weight = peak.magnitude;
      totalError += errorHz * weight;
      totalWeight += weight;
    }

    if (totalWeight > 0) {
      this.offsetHz = totalError / totalWeight;

      // Clamp to maximum expected offset
      if (Math.abs(this.offsetHz) > this.maxOffsetHz) {
        // Large offset might indicate wrong mode or noise
        this.confidence = Math.max(0, 1 - Math.abs(this.offsetHz) / (this.maxOffsetHz * 2));
        this.offsetHz = Math.sign(this.offsetHz) * this.maxOffsetHz;
      } else {
        // Calculate confidence based on measurement consistency
        this.confidence = this.calculateConfidence();
      }
    } else {
      this.offsetHz = 0;
      this.confidence = 0;
    }

    return {
      offsetHz: this.offsetHz,
      confidence: this.confidence,
      measurements: this.measurements,
    };
  }

  /**
   * Calculate confidence based on measurement consistency
   */
  private calculateConfidence(): number {
    if (this.measurements.length < 2) {
      return 0.5; // Single measurement, moderate confidence
    }

    // Calculate standard deviation of error measurements
    const errors = this.measurements.map(m => m.errorHz);
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;
    const variance = errors.reduce((sum, e) => sum + (e - mean) ** 2, 0) / errors.length;
    const stdDev = Math.sqrt(variance);

    // High consistency (low stdDev) = high confidence
    // If stdDev > 20 Hz, confidence drops significantly
    const consistencyScore = Math.max(0, 1 - stdDev / 20);

    // Also factor in measurement count
    const countScore = Math.min(1, this.measurements.length / 4);

    return consistencyScore * 0.7 + countScore * 0.3;
  }

  /**
   * Get compensated frequency for a tone index
   *
   * @param toneIndex - The tone index (0 to NUM_TONES-1)
   * @returns Compensated frequency in Hz
   */
  getCompensatedFrequency(toneIndex: number): number {
    if (toneIndex < 0 || toneIndex >= TONE_FREQUENCIES.length) {
      return TONE_FREQUENCIES[0]; // Fallback
    }
    return TONE_FREQUENCIES[toneIndex] + this.offsetHz;
  }

  /**
   * Get all compensated tone frequencies
   */
  getCompensatedToneFrequencies(): number[] {
    return TONE_FREQUENCIES.map(f => f + this.offsetHz);
  }

  /**
   * Get current offset estimate
   */
  getOffset(): number {
    return this.offsetHz;
  }

  /**
   * Get confidence in current estimate
   */
  getConfidence(): number {
    return this.confidence;
  }

  /**
   * Reset tracker state
   */
  reset(): void {
    this.offsetHz = 0;
    this.confidence = 0;
    this.measurements = [];
  }

  /**
   * Set offset manually (for testing or external estimation)
   */
  setOffset(offsetHz: number, confidence: number = 1): void {
    this.offsetHz = Math.max(-this.maxOffsetHz, Math.min(this.maxOffsetHz, offsetHz));
    this.confidence = Math.max(0, Math.min(1, confidence));
  }
}

/**
 * Apply frequency offset compensation to tone detection
 *
 * @param magnitudes - FFT magnitude array
 * @param sampleRate - Sample rate
 * @param offsetHz - Frequency offset to compensate for
 * @returns Detected tone index and confidence
 */
export function detectToneWithOffset(
  magnitudes: Float32Array,
  sampleRate: number,
  offsetHz: number
): { tone: number; confidence: number } {
  const binWidth = sampleRate / (magnitudes.length * 2);

  let bestTone = 0;
  let bestMagnitude = 0;
  let totalMagnitude = 0;

  for (let i = 0; i < TONE_FREQUENCIES.length; i++) {
    // Compensate for frequency offset
    const compensatedFreq = TONE_FREQUENCIES[i] + offsetHz;
    const bin = Math.round(compensatedFreq / binWidth);

    if (bin >= 0 && bin < magnitudes.length) {
      // Sum magnitudes in a small window around the expected bin
      let magnitude = 0;
      const windowSize = Math.max(1, Math.round(AUDIO.TONE_SPACING / binWidth / 4));

      for (let j = -windowSize; j <= windowSize; j++) {
        const idx = bin + j;
        if (idx >= 0 && idx < magnitudes.length) {
          magnitude += magnitudes[idx];
        }
      }

      totalMagnitude += magnitude;

      if (magnitude > bestMagnitude) {
        bestMagnitude = magnitude;
        bestTone = i;
      }
    }
  }

  const confidence = totalMagnitude > 0 ? bestMagnitude / totalMagnitude : 0;

  return { tone: bestTone, confidence };
}

// Default instance for simple usage
let defaultTracker: FrequencyOffsetTracker | null = null;

export function getDefaultTracker(): FrequencyOffsetTracker {
  if (!defaultTracker) {
    defaultTracker = new FrequencyOffsetTracker();
  }
  return defaultTracker;
}

export function resetDefaultTracker(): void {
  if (defaultTracker) {
    defaultTracker.reset();
  }
}
