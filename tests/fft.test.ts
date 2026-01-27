import { describe, it, expect } from 'vitest';
import { fft, magnitude, findPeakFrequency, detectTone } from '../src/lib/fft';
import { TONE_FREQUENCIES, AUDIO } from '../src/utils/constants';

describe('FFT', () => {
  const sampleRate = 48000;

  function generateSineWave(frequency: number, duration: number, sampleRate: number): Float32Array {
    const samples = Math.floor(duration * sampleRate);
    const result = new Float32Array(samples);
    const angularFreq = (2 * Math.PI * frequency) / sampleRate;

    for (let i = 0; i < samples; i++) {
      result[i] = Math.sin(angularFreq * i);
    }

    return result;
  }

  describe('fft', () => {
    it('should return complex array', () => {
      const signal = new Float32Array(256).fill(0);
      const result = fft(signal);

      expect(result.length).toBe(512); // 256 samples -> 256 complex pairs
    });

    it('should detect DC component', () => {
      const signal = new Float32Array(256).fill(1);
      const result = fft(signal);
      const mags = magnitude(result);

      // DC component should be at bin 0
      expect(mags[0]).toBeGreaterThan(0);
    });
  });

  describe('magnitude', () => {
    it('should compute magnitude spectrum', () => {
      const signal = generateSineWave(1000, 0.05, sampleRate);
      const result = fft(signal);
      const mags = magnitude(result);

      // Magnitude should be non-negative
      for (let i = 0; i < mags.length; i++) {
        expect(mags[i]).toBeGreaterThanOrEqual(0);
      }
    });
  });

  describe('findPeakFrequency', () => {
    it('should find peak frequency of a sine wave', () => {
      const testFreq = 2000;
      const signal = generateSineWave(testFreq, 0.05, sampleRate);
      const result = fft(signal);
      const mags = magnitude(result);

      const peak = findPeakFrequency(mags, sampleRate, 1500, 2500);

      // Should be within one FFT bin of the actual frequency
      const binWidth = sampleRate / (mags.length * 2);
      expect(Math.abs(peak.frequency - testFreq)).toBeLessThan(binWidth * 2);
    });

    it('should find peaks at various frequencies', () => {
      const testFreqs = [1800, 2500, 3500, 5000];

      for (const testFreq of testFreqs) {
        const signal = generateSineWave(testFreq, 0.04, sampleRate);
        const result = fft(signal);
        const mags = magnitude(result);

        const peak = findPeakFrequency(mags, sampleRate, testFreq - 500, testFreq + 500);
        const binWidth = sampleRate / (mags.length * 2);

        expect(Math.abs(peak.frequency - testFreq)).toBeLessThan(binWidth * 2);
      }
    });
  });

  describe('detectTone', () => {
    it('should detect MFSK tones', () => {
      // Test each tone in our frequency plan
      for (let toneIndex = 0; toneIndex < TONE_FREQUENCIES.length; toneIndex++) {
        const freq = TONE_FREQUENCIES[toneIndex];
        const signal = generateSineWave(freq, 0.04, sampleRate);
        const result = fft(signal);
        const mags = magnitude(result);

        const detected = detectTone(mags, sampleRate, TONE_FREQUENCIES, AUDIO.TONE_SPACING);

        expect(detected.tone).toBe(toneIndex);
        expect(detected.confidence).toBeGreaterThan(0.1);
      }
    });
  });
});
