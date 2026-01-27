/**
 * Symbol detection using FFT
 */
import { fft, magnitude, detectTone, findPeakFrequency } from '../lib/fft';
import { AUDIO, TONE_FREQUENCIES } from '../utils/constants';

export interface DetectionResult {
  tone: number;
  confidence: number;
  frequency: number;
  magnitude: number;
}

/**
 * Detect which MFSK tone is present in an audio buffer
 */
export function detectSymbol(
  samples: Float32Array,
  sampleRate: number
): DetectionResult {
  // Compute FFT
  const fftResult = fft(samples);
  const magnitudes = magnitude(fftResult);

  // Detect which tone is present
  const { tone, confidence } = detectTone(
    magnitudes,
    sampleRate,
    TONE_FREQUENCIES,
    AUDIO.TONE_SPACING
  );

  // Find exact peak frequency for debugging
  const peak = findPeakFrequency(
    magnitudes,
    sampleRate,
    AUDIO.BASE_FREQUENCY - 200,
    TONE_FREQUENCIES[TONE_FREQUENCIES.length - 1] + 200
  );

  return {
    tone,
    confidence,
    frequency: peak.frequency,
    magnitude: peak.magnitude,
  };
}

/**
 * Detect tone with threshold checking
 * Returns -1 if no confident detection
 */
export function detectSymbolWithThreshold(
  samples: Float32Array,
  sampleRate: number,
  confidenceThreshold: number = 0.3
): number {
  const result = detectSymbol(samples, sampleRate);

  if (result.confidence < confidenceThreshold) {
    return -1;
  }

  return result.tone;
}

/**
 * Detect chirp (for preamble detection)
 * Returns confidence level (0-1)
 */
export function detectChirp(
  samples: Float32Array,
  sampleRate: number
): number {
  // Split samples into segments and check for increasing/decreasing frequency
  const segmentCount = 8;
  const segmentSize = Math.floor(samples.length / segmentCount);

  const peakFrequencies: number[] = [];

  for (let i = 0; i < segmentCount; i++) {
    const start = i * segmentSize;
    const segment = samples.subarray(start, start + segmentSize);

    const fftResult = fft(segment);
    const magnitudes = magnitude(fftResult);

    const peak = findPeakFrequency(
      magnitudes,
      sampleRate,
      AUDIO.CHIRP_START_HZ - 500,
      AUDIO.CHIRP_PEAK_HZ + 500
    );

    peakFrequencies.push(peak.frequency);
  }

  // Check if first half is increasing and second half is decreasing
  let increasingCount = 0;
  let decreasingCount = 0;

  for (let i = 1; i < segmentCount / 2; i++) {
    if (peakFrequencies[i] > peakFrequencies[i - 1]) increasingCount++;
  }

  for (let i = segmentCount / 2 + 1; i < segmentCount; i++) {
    if (peakFrequencies[i] < peakFrequencies[i - 1]) decreasingCount++;
  }

  const maxInc = segmentCount / 2 - 1;
  const maxDec = segmentCount / 2 - 1;

  return ((increasingCount / maxInc) + (decreasingCount / maxDec)) / 2;
}

/**
 * Calculate signal energy in our frequency band
 */
export function calculateSignalEnergy(
  samples: Float32Array,
  sampleRate: number
): number {
  const fftResult = fft(samples);
  const magnitudes = magnitude(fftResult);

  const binWidth = sampleRate / (magnitudes.length * 2);
  const minBin = Math.floor(AUDIO.BASE_FREQUENCY / binWidth);
  const maxBin = Math.ceil(TONE_FREQUENCIES[TONE_FREQUENCIES.length - 1] / binWidth);

  let energy = 0;
  for (let i = minBin; i < maxBin && i < magnitudes.length; i++) {
    energy += magnitudes[i] * magnitudes[i];
  }

  return Math.sqrt(energy / (maxBin - minBin));
}
