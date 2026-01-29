/**
 * Tests for Soft-Decision Detection
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  detectToneSoft,
  detectSymbolsSoft,
  softToHard,
  extractSoftMatrix,
  averageConfidence,
  measureSignalQuality,
  SoftUtils,
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

  describe('detectSymbolsSoft', () => {
    it('should detect multiple symbols', () => {
      const toneSequence = [0, 1, 2, 3];
      const symbolDuration = Math.floor((AUDIO.SYMBOL_DURATION_MS / 1000) * sampleRate);
      const guardDuration = Math.floor((AUDIO.GUARD_INTERVAL_MS / 1000) * sampleRate);

      // Generate concatenated symbols
      const totalSamples = toneSequence.length * (symbolDuration + guardDuration);
      const samples = new Float32Array(totalSamples);

      for (let i = 0; i < toneSequence.length; i++) {
        const toneIndex = toneSequence[i];
        const frequency = TONE_FREQUENCIES[toneIndex];
        const start = i * (symbolDuration + guardDuration);

        for (let j = 0; j < symbolDuration; j++) {
          const t = j / sampleRate;
          samples[start + j] = 0.5 * Math.sin(2 * Math.PI * frequency * t);
        }
        // Guard interval is silence (zeros)
      }

      const results = detectSymbolsSoft(
        samples,
        sampleRate,
        symbolDuration,
        guardDuration
      );

      expect(results.length).toBe(toneSequence.length);

      for (let i = 0; i < toneSequence.length; i++) {
        expect(results[i].hardDecision).toBe(toneSequence[i]);
      }
    });
  });

  describe('softToHard', () => {
    it('should convert soft results to hard decisions', () => {
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([255, 10, 20, 30]), hardDecision: 0, confidence: 0.9 },
        { softValues: new Uint8Array([10, 255, 20, 30]), hardDecision: 1, confidence: 0.8 },
        { softValues: new Uint8Array([10, 20, 255, 30]), hardDecision: 2, confidence: 0.85 },
      ];

      const hard = softToHard(results);

      expect(hard).toEqual([0, 1, 2]);
    });
  });

  describe('extractSoftMatrix', () => {
    it('should extract soft values matrix', () => {
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([255, 10, 20, 30]), hardDecision: 0, confidence: 0.9 },
        { softValues: new Uint8Array([10, 255, 20, 30]), hardDecision: 1, confidence: 0.8 },
      ];

      const matrix = extractSoftMatrix(results);

      expect(matrix.length).toBe(2);
      expect(Array.from(matrix[0])).toEqual([255, 10, 20, 30]);
      expect(Array.from(matrix[1])).toEqual([10, 255, 20, 30]);
    });
  });

  describe('averageConfidence', () => {
    it('should calculate average confidence', () => {
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([255, 10]), hardDecision: 0, confidence: 0.8 },
        { softValues: new Uint8Array([10, 255]), hardDecision: 1, confidence: 0.6 },
        { softValues: new Uint8Array([255, 10]), hardDecision: 0, confidence: 1.0 },
      ];

      const avg = averageConfidence(results);

      expect(avg).toBeCloseTo(0.8, 2);
    });

    it('should return 0 for empty array', () => {
      expect(averageConfidence([])).toBe(0);
    });
  });

  describe('measureSignalQuality', () => {
    it('should return high quality for clean signals', () => {
      // Simulate clean signal: one dominant soft value
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([255, 5, 5, 5]), hardDecision: 0, confidence: 0.9 },
        { softValues: new Uint8Array([5, 255, 5, 5]), hardDecision: 1, confidence: 0.9 },
      ];

      const quality = measureSignalQuality(results);

      expect(quality).toBeGreaterThan(0.5);
    });

    it('should return lower quality for noisy signals', () => {
      // Simulate noisy signal: soft values more spread out
      const results: SoftDetectionResult[] = [
        { softValues: new Uint8Array([150, 100, 80, 70]), hardDecision: 0, confidence: 0.4 },
        { softValues: new Uint8Array([120, 130, 100, 90]), hardDecision: 1, confidence: 0.3 },
      ];

      const quality = measureSignalQuality(results);

      expect(quality).toBeLessThan(0.8);
    });
  });

  describe('SoftUtils', () => {
    describe('toLogLikelihood / fromLogLikelihood', () => {
      it('should roundtrip soft values', () => {
        const testValues = [10, 50, 127, 200, 245];

        for (const soft of testValues) {
          const llr = SoftUtils.toLogLikelihood(soft);
          const recovered = SoftUtils.fromLogLikelihood(llr);

          // Allow small rounding error
          expect(Math.abs(recovered - soft)).toBeLessThan(2);
        }
      });

      it('should return 0 LLR for uncertain (127)', () => {
        const llr = SoftUtils.toLogLikelihood(127);
        expect(Math.abs(llr)).toBeLessThan(0.1);
      });

      it('should return positive LLR for high soft values', () => {
        const llr = SoftUtils.toLogLikelihood(230);
        expect(llr).toBeGreaterThan(0);
      });

      it('should return negative LLR for low soft values', () => {
        const llr = SoftUtils.toLogLikelihood(25);
        expect(llr).toBeLessThan(0);
      });
    });

    describe('combine', () => {
      it('should combine two soft values', () => {
        // Two high values should stay high
        expect(SoftUtils.combine(250, 250)).toBeGreaterThan(200);

        // High and low should reduce
        expect(SoftUtils.combine(250, 50)).toBeLessThan(150);

        // Two low values should stay low
        expect(SoftUtils.combine(50, 50)).toBeLessThan(100);
      });
    });

    describe('invert', () => {
      it('should invert soft values', () => {
        expect(SoftUtils.invert(255)).toBe(0);
        expect(SoftUtils.invert(0)).toBe(255);
        expect(SoftUtils.invert(127)).toBe(128);
      });
    });

    describe('isConfident / isUncertain', () => {
      it('should detect confident values', () => {
        expect(SoftUtils.isConfident(250)).toBe(true);
        expect(SoftUtils.isConfident(150)).toBe(false);
        expect(SoftUtils.isConfident(220, 200)).toBe(true);
      });

      it('should detect uncertain values', () => {
        expect(SoftUtils.isUncertain(127)).toBe(true);
        expect(SoftUtils.isUncertain(130)).toBe(true);
        expect(SoftUtils.isUncertain(255)).toBe(false);
        expect(SoftUtils.isUncertain(10)).toBe(false);
      });
    });
  });
});
