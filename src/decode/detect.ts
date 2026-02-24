/**
 * Signal detection utilities using FFT
 */
import { fft, magnitude } from '../lib/fft';
import { AUDIO, TONE_FREQUENCIES } from '../utils/constants';

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
