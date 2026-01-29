/**
 * Tests for Frequency Offset Tracking
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  FrequencyOffsetTracker,
  detectToneWithOffset,
} from '../src/decode/freq-offset';
import { setAudioMode, TONE_FREQUENCIES, AUDIO } from '../src/utils/constants';

// Helper to generate a test tone
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

// Helper to generate calibration tones with optional frequency offset
function generateCalibrationTones(
  toneIndices: number[],
  sampleRate: number,
  symbolDurationMs: number,
  offsetHz: number = 0
): Float32Array {
  const symbolSamples = Math.floor((symbolDurationMs / 1000) * sampleRate);
  const totalSamples = symbolSamples * toneIndices.length;
  const samples = new Float32Array(totalSamples);

  for (let i = 0; i < toneIndices.length; i++) {
    const toneIndex = toneIndices[i];
    const frequency = TONE_FREQUENCIES[toneIndex] + offsetHz;
    const startSample = i * symbolSamples;

    for (let j = 0; j < symbolSamples; j++) {
      const t = j / sampleRate;
      samples[startSample + j] = 0.5 * Math.sin(2 * Math.PI * frequency * t);
    }
  }

  return samples;
}

describe('FrequencyOffsetTracker', () => {
  let tracker: FrequencyOffsetTracker;
  const sampleRate = 48000;

  beforeEach(() => {
    setAudioMode('phone');
    tracker = new FrequencyOffsetTracker(30); // Max 30 Hz offset
  });

  describe('estimateOffset', () => {
    it('should detect zero offset with perfect calibration tones', () => {
      const calibTones = AUDIO.CALIBRATION_TONES;
      const symbolDurationMs = AUDIO.SYMBOL_DURATION_MS;
      const symbolSamples = Math.floor((symbolDurationMs / 1000) * sampleRate);

      const samples = generateCalibrationTones(
        calibTones,
        sampleRate,
        symbolDurationMs,
        0 // No offset
      );

      const result = tracker.estimateOffset(
        samples,
        sampleRate,
        calibTones,
        symbolSamples
      );

      expect(Math.abs(result.offsetHz)).toBeLessThan(5); // Within 5 Hz
      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.measurements.length).toBe(calibTones.length);
    });

    it('should detect positive frequency offset', () => {
      const calibTones = AUDIO.CALIBRATION_TONES;
      const symbolDurationMs = AUDIO.SYMBOL_DURATION_MS;
      const symbolSamples = Math.floor((symbolDurationMs / 1000) * sampleRate);
      const actualOffset = 15; // +15 Hz

      const samples = generateCalibrationTones(
        calibTones,
        sampleRate,
        symbolDurationMs,
        actualOffset
      );

      const result = tracker.estimateOffset(
        samples,
        sampleRate,
        calibTones,
        symbolSamples
      );

      expect(result.offsetHz).toBeGreaterThan(10);
      expect(result.offsetHz).toBeLessThan(20);
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should detect negative frequency offset', () => {
      const calibTones = AUDIO.CALIBRATION_TONES;
      const symbolDurationMs = AUDIO.SYMBOL_DURATION_MS;
      const symbolSamples = Math.floor((symbolDurationMs / 1000) * sampleRate);
      const actualOffset = -20; // -20 Hz

      const samples = generateCalibrationTones(
        calibTones,
        sampleRate,
        symbolDurationMs,
        actualOffset
      );

      const result = tracker.estimateOffset(
        samples,
        sampleRate,
        calibTones,
        symbolSamples
      );

      expect(result.offsetHz).toBeLessThan(-15);
      expect(result.offsetHz).toBeGreaterThan(-25);
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should clamp large offsets', () => {
      const calibTones = AUDIO.CALIBRATION_TONES;
      const symbolDurationMs = AUDIO.SYMBOL_DURATION_MS;
      const symbolSamples = Math.floor((symbolDurationMs / 1000) * sampleRate);
      const actualOffset = 50; // Beyond max offset

      const samples = generateCalibrationTones(
        calibTones,
        sampleRate,
        symbolDurationMs,
        actualOffset
      );

      const result = tracker.estimateOffset(
        samples,
        sampleRate,
        calibTones,
        symbolSamples
      );

      expect(Math.abs(result.offsetHz)).toBeLessThanOrEqual(30);
      expect(result.confidence).toBeLessThan(0.8); // Lower confidence for clamped
    });

    it('should work in wideband mode', () => {
      setAudioMode('wideband');
      tracker = new FrequencyOffsetTracker(20); // Wideband: ±20 Hz

      const calibTones = AUDIO.CALIBRATION_TONES;
      const symbolDurationMs = AUDIO.SYMBOL_DURATION_MS;
      const symbolSamples = Math.floor((symbolDurationMs / 1000) * sampleRate);
      const actualOffset = 10;

      const samples = generateCalibrationTones(
        calibTones,
        sampleRate,
        symbolDurationMs,
        actualOffset
      );

      const result = tracker.estimateOffset(
        samples,
        sampleRate,
        calibTones,
        symbolSamples
      );

      expect(result.offsetHz).toBeGreaterThan(5);
      expect(result.offsetHz).toBeLessThan(15);
    });
  });

  describe('getCompensatedFrequency', () => {
    it('should return compensated frequencies', () => {
      tracker.setOffset(10, 1);

      const original = TONE_FREQUENCIES[0];
      const compensated = tracker.getCompensatedFrequency(0);

      expect(compensated).toBe(original + 10);
    });

    it('should handle all tone indices', () => {
      tracker.setOffset(-5, 1);

      for (let i = 0; i < TONE_FREQUENCIES.length; i++) {
        const compensated = tracker.getCompensatedFrequency(i);
        expect(compensated).toBe(TONE_FREQUENCIES[i] - 5);
      }
    });
  });

  describe('reset', () => {
    it('should reset offset and confidence', () => {
      tracker.setOffset(15, 0.9);
      expect(tracker.getOffset()).toBe(15);

      tracker.reset();

      expect(tracker.getOffset()).toBe(0);
      expect(tracker.getConfidence()).toBe(0);
    });
  });
});

describe('detectToneWithOffset', () => {
  const sampleRate = 48000;

  beforeEach(() => {
    setAudioMode('phone');
  });

  // Helper to generate FFT magnitudes for a given frequency
  function generateMagnitudesForFrequency(
    frequency: number,
    fftSize: number = 2048
  ): Float32Array {
    const samples = generateTone(frequency, 50, sampleRate);

    // Simple DFT to get magnitudes (not efficient but clear)
    const magnitudes = new Float32Array(fftSize / 2);
    const binWidth = sampleRate / fftSize;

    for (let bin = 0; bin < magnitudes.length; bin++) {
      const binFreq = bin * binWidth;
      // Approximate: peak at the frequency bin
      const distance = Math.abs(binFreq - frequency);
      magnitudes[bin] = Math.max(0, 1 - distance / 100) * 100;
    }

    return magnitudes;
  }

  it('should detect tone at expected frequency with zero offset', () => {
    const toneIndex = 1;
    const frequency = TONE_FREQUENCIES[toneIndex];
    const magnitudes = generateMagnitudesForFrequency(frequency);

    const result = detectToneWithOffset(magnitudes, sampleRate, 0);

    expect(result.tone).toBe(toneIndex);
    expect(result.confidence).toBeGreaterThan(0.3);
  });

  it('should detect shifted tone with offset compensation', () => {
    const toneIndex = 2;
    const offset = 15;
    // Generate tone at shifted frequency
    const actualFrequency = TONE_FREQUENCIES[toneIndex] + offset;
    const magnitudes = generateMagnitudesForFrequency(actualFrequency);

    // Without compensation, might detect wrong tone
    const resultNoOffset = detectToneWithOffset(magnitudes, sampleRate, 0);

    // With compensation, should detect correct tone
    const resultWithOffset = detectToneWithOffset(magnitudes, sampleRate, offset);

    expect(resultWithOffset.tone).toBe(toneIndex);
    expect(resultWithOffset.confidence).toBeGreaterThan(resultNoOffset.confidence * 0.5);
  });
});

describe('Integration: Offset estimation and detection', () => {
  const sampleRate = 48000;

  beforeEach(() => {
    setAudioMode('phone');
  });

  it('should estimate offset from calibration and use for detection', () => {
    const offset = 12; // Simulate +12 Hz offset
    const tracker = new FrequencyOffsetTracker(30);

    // Generate calibration tones with offset
    const calibTones = AUDIO.CALIBRATION_TONES;
    const symbolDurationMs = AUDIO.SYMBOL_DURATION_MS;
    const symbolSamples = Math.floor((symbolDurationMs / 1000) * sampleRate);

    const calibSamples = generateCalibrationTones(
      calibTones,
      sampleRate,
      symbolDurationMs,
      offset
    );

    // Estimate offset
    const result = tracker.estimateOffset(
      calibSamples,
      sampleRate,
      calibTones,
      symbolSamples
    );

    // Verify estimation is close
    expect(Math.abs(result.offsetHz - offset)).toBeLessThan(5);

    // Use estimated offset for detection
    const estimatedOffset = tracker.getOffset();
    const compensatedFreqs = tracker.getCompensatedToneFrequencies();

    // Compensated frequencies should be close to actual transmitted frequencies
    for (let i = 0; i < TONE_FREQUENCIES.length; i++) {
      const expected = TONE_FREQUENCIES[i] + offset;
      const compensated = compensatedFreqs[i];
      expect(Math.abs(compensated - expected)).toBeLessThan(10);
    }
  });
});
