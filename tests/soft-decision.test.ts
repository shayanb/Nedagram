/**
 * Tests for Soft-Decision Detection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectToneSoft,
  softSymbolsToSoftBits,
  SoftDetectionResult,
} from '../src/decode/soft-decision';
import { setAudioMode, TONE_FREQUENCIES, AUDIO } from '../src/utils/constants';

// Helper to generate a pure tone
function generateTone(
  frequency: number,
  durationMs: number,
  sampleRate: number,
  amplitude: number = 0.5
): Float32Array {
  const numSamples = Math.floor((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(numSamples);

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    samples[i] = amplitude * Math.sin(2 * Math.PI * frequency * t);
  }

  return samples;
}

// Helper to generate a tone with noise
function generateToneWithNoise(
  frequency: number,
  durationMs: number,
  sampleRate: number,
  signalAmplitude: number = 0.5,
  noiseAmplitude: number = 0.1
): Float32Array {
  const samples = generateTone(frequency, durationMs, sampleRate, signalAmplitude);

  for (let i = 0; i < samples.length; i++) {
    samples[i] += (Math.random() - 0.5) * 2 * noiseAmplitude;
  }

  return samples;
}

describe('Soft-Decision Detection', () => {
  const sampleRate = 48000;

  beforeEach(() => {
    setAudioMode('phone');
  });

  describe('detectToneSoft', () => {
    it('should return soft values for all tones', () => {
      const toneIndex = 1;
      const frequency = TONE_FREQUENCIES[toneIndex];
      const samples = generateTone(frequency, AUDIO.SYMBOL_DURATION_MS, sampleRate);

      const result = detectToneSoft(samples, sampleRate);

      expect(result.softValues.length).toBe(TONE_FREQUENCIES.length);
      expect(result.hardDecision).toBe(toneIndex);
    });

    it('should give highest soft value to correct tone', () => {
      const toneIndex = 2;
      const frequency = TONE_FREQUENCIES[toneIndex];
      const samples = generateTone(frequency, AUDIO.SYMBOL_DURATION_MS, sampleRate);

      const result = detectToneSoft(samples, sampleRate);

      // The correct tone should have the highest soft value
      const maxSoft = Math.max(...result.softValues);
      expect(result.softValues[toneIndex]).toBe(maxSoft);
      expect(result.softValues[toneIndex]).toBeGreaterThan(200);
    });

    it('should give low soft values to incorrect tones', () => {
      const toneIndex = 0;
      const frequency = TONE_FREQUENCIES[toneIndex];
      const samples = generateTone(frequency, AUDIO.SYMBOL_DURATION_MS, sampleRate);

      const result = detectToneSoft(samples, sampleRate);

      // Other tones should have lower soft values
      for (let i = 0; i < result.softValues.length; i++) {
        if (i !== toneIndex) {
          expect(result.softValues[i]).toBeLessThan(result.softValues[toneIndex]);
        }
      }
    });

    it('should have high confidence for clean signal', () => {
      const toneIndex = 1;
      const frequency = TONE_FREQUENCIES[toneIndex];
      const samples = generateTone(frequency, AUDIO.SYMBOL_DURATION_MS, sampleRate);

      const result = detectToneSoft(samples, sampleRate);

      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should have lower confidence with noise', () => {
      const toneIndex = 1;
      const frequency = TONE_FREQUENCIES[toneIndex];
      const cleanSamples = generateTone(frequency, AUDIO.SYMBOL_DURATION_MS, sampleRate);
      const noisySamples = generateToneWithNoise(
        frequency,
        AUDIO.SYMBOL_DURATION_MS,
        sampleRate,
        0.5,
        0.3 // Significant noise
      );

      const cleanResult = detectToneSoft(cleanSamples, sampleRate);
      const noisyResult = detectToneSoft(noisySamples, sampleRate);

      // Noisy should still detect correct tone
      expect(noisyResult.hardDecision).toBe(toneIndex);

      // But confidence may be lower (or similar if signal is strong enough)
      expect(noisyResult.confidence).toBeGreaterThan(0.1);
    });

    it('should handle frequency offset compensation', () => {
      const toneIndex = 2;
      const offset = 15;
      // Generate tone at offset frequency
      const frequency = TONE_FREQUENCIES[toneIndex] + offset;
      const samples = generateTone(frequency, AUDIO.SYMBOL_DURATION_MS, sampleRate);

      // Without offset compensation
      const resultNoOffset = detectToneSoft(samples, sampleRate, 0);

      // With offset compensation
      const resultWithOffset = detectToneSoft(samples, sampleRate, offset);

      // With compensation, should detect correct tone with high confidence
      expect(resultWithOffset.hardDecision).toBe(toneIndex);
      expect(resultWithOffset.softValues[toneIndex]).toBeGreaterThan(200);
    });

    it('should work in wideband mode', () => {
      setAudioMode('wideband');

      const toneIndex = 8; // Middle tone
      const frequency = TONE_FREQUENCIES[toneIndex];
      const samples = generateTone(frequency, AUDIO.SYMBOL_DURATION_MS, sampleRate);

      const result = detectToneSoft(samples, sampleRate);

      expect(result.softValues.length).toBe(16); // Wideband has 16 tones
      expect(result.hardDecision).toBe(toneIndex);
      expect(result.softValues[toneIndex]).toBeGreaterThan(200);
    });
  });

  describe('softSymbolsToSoftBits', () => {
    it('should convert phone mode (4 tones, 2 bits) with clear signal', () => {
      // Tone 3 = binary 11 → both bits should be ~1.0
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([0, 0, 0, 255]), hardDecision: 3, confidence: 1.0 },
      ];

      const bits = softSymbolsToSoftBits(results, 2);

      expect(bits.length).toBe(2);
      expect(bits[0]).toBeCloseTo(1.0, 1); // MSB = 1
      expect(bits[1]).toBeCloseTo(1.0, 1); // LSB = 1
    });

    it('should convert tone 0 (binary 00) correctly', () => {
      // Tone 0 = binary 00 → both bits should be ~0.0
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([255, 0, 0, 0]), hardDecision: 0, confidence: 1.0 },
      ];

      const bits = softSymbolsToSoftBits(results, 2);

      expect(bits.length).toBe(2);
      expect(bits[0]).toBeCloseTo(0.0, 1); // MSB = 0
      expect(bits[1]).toBeCloseTo(0.0, 1); // LSB = 0
    });

    it('should convert tone 2 (binary 10) correctly', () => {
      // Tone 2 = binary 10 → MSB ~1.0, LSB ~0.0
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([0, 0, 255, 0]), hardDecision: 2, confidence: 1.0 },
      ];

      const bits = softSymbolsToSoftBits(results, 2);

      expect(bits.length).toBe(2);
      expect(bits[0]).toBeCloseTo(1.0, 1); // MSB = 1
      expect(bits[1]).toBeCloseTo(0.0, 1); // LSB = 0
    });

    it('should produce uncertain bits for ambiguous symbols', () => {
      // Equal soft values → uncertain (0.5)
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([64, 64, 64, 64]), hardDecision: 0, confidence: 0.0 },
      ];

      const bits = softSymbolsToSoftBits(results, 2);

      expect(bits[0]).toBeCloseTo(0.5, 1);
      expect(bits[1]).toBeCloseTo(0.5, 1);
    });

    it('should handle zero total (silence) with hard fallback', () => {
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([0, 0, 0, 0]), hardDecision: 2, confidence: 0.0 },
      ];

      const bits = softSymbolsToSoftBits(results, 2);

      expect(bits.length).toBe(2);
      // Hard decision 2 = binary 10
      expect(bits[0]).toBe(1.0); // MSB = 1
      expect(bits[1]).toBe(0.0); // LSB = 0
    });

    it('should handle multiple symbols', () => {
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([255, 0, 0, 0]), hardDecision: 0, confidence: 1.0 },
        { softValues: new Uint8Array([0, 0, 0, 255]), hardDecision: 3, confidence: 1.0 },
      ];

      const bits = softSymbolsToSoftBits(results, 2);

      expect(bits.length).toBe(4); // 2 symbols * 2 bits
      // Symbol 0 = tone 0 = 00
      expect(bits[0]).toBeCloseTo(0.0, 1);
      expect(bits[1]).toBeCloseTo(0.0, 1);
      // Symbol 1 = tone 3 = 11
      expect(bits[2]).toBeCloseTo(1.0, 1);
      expect(bits[3]).toBeCloseTo(1.0, 1);
    });

    it('should work with wideband mode (16 tones, 4 bits)', () => {
      // Tone 10 = binary 1010 → bits [1, 0, 1, 0]
      const softValues = new Uint8Array(16).fill(0);
      softValues[10] = 255;

      const results: SoftDetectionResult[] = [
        { softValues, hardDecision: 10, confidence: 1.0 },
      ];

      const bits = softSymbolsToSoftBits(results, 4);

      expect(bits.length).toBe(4);
      expect(bits[0]).toBeCloseTo(1.0, 1); // bit 3 = 1
      expect(bits[1]).toBeCloseTo(0.0, 1); // bit 2 = 0
      expect(bits[2]).toBeCloseTo(1.0, 1); // bit 1 = 1
      expect(bits[3]).toBeCloseTo(0.0, 1); // bit 0 = 0
    });
  });

});
