/**
 * Chirp detection using matched filter correlation
 *
 * Matched filtering correlates the received signal with a known chirp template.
 * The correlation peak indicates when the chirp occurred, even in noisy conditions.
 */

import { AUDIO, PHONE_MODE, WIDEBAND_MODE, type AudioMode } from '../utils/constants';

/**
 * Generate a chirp signal template for matched filtering
 */
export function generateChirpTemplate(
  startFreq: number,
  endFreq: number,
  durationMs: number,
  sampleRate: number
): Float32Array {
  const samples = Math.floor((durationMs / 1000) * sampleRate);
  const result = new Float32Array(samples);

  const k = (endFreq - startFreq) / (durationMs / 1000);

  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (startFreq * t + (k * t * t) / 2);
    result[i] = Math.sin(phase);
  }

  return result;
}

/**
 * Generate the up-down chirp template used in preamble
 * If mode is specified, uses that mode's frequencies; otherwise uses current AUDIO settings
 */
export function generatePreambleChirpTemplate(sampleRate: number, mode?: AudioMode): Float32Array {
  const settings = mode
    ? (mode === 'phone' ? PHONE_MODE : WIDEBAND_MODE)
    : AUDIO;

  const upChirp = generateChirpTemplate(
    settings.CHIRP_START_HZ,
    settings.CHIRP_PEAK_HZ,
    settings.CHIRP_DURATION_MS / 2,
    sampleRate
  );

  const downChirp = generateChirpTemplate(
    settings.CHIRP_PEAK_HZ,
    settings.CHIRP_START_HZ,
    settings.CHIRP_DURATION_MS / 2,
    sampleRate
  );

  // Concatenate up and down chirps
  const template = new Float32Array(upChirp.length + downChirp.length);
  template.set(upChirp, 0);
  template.set(downChirp, upChirp.length);

  return template;
}

/**
 * Compute normalized cross-correlation between signal and template
 * Returns correlation values and the index of the peak
 *
 * Uses a sliding window approach for efficiency
 */
export function correlateWithTemplate(
  signal: Float32Array,
  template: Float32Array,
  stepSize: number = 1
): { correlation: Float32Array; peakIndex: number; peakValue: number } {
  const signalLen = signal.length;
  const templateLen = template.length;

  if (signalLen < templateLen) {
    return { correlation: new Float32Array(0), peakIndex: -1, peakValue: 0 };
  }

  // Pre-compute template energy for normalization
  let templateEnergy = 0;
  for (let i = 0; i < templateLen; i++) {
    templateEnergy += template[i] * template[i];
  }
  const templateNorm = Math.sqrt(templateEnergy);

  const numCorrelations = Math.floor((signalLen - templateLen) / stepSize) + 1;
  const correlation = new Float32Array(numCorrelations);

  let peakValue = -Infinity;
  let peakIndex = -1;

  for (let i = 0; i < numCorrelations; i++) {
    const offset = i * stepSize;

    // Compute cross-correlation at this offset
    let dotProduct = 0;
    let signalEnergy = 0;

    for (let j = 0; j < templateLen; j++) {
      const s = signal[offset + j];
      dotProduct += s * template[j];
      signalEnergy += s * s;
    }

    // Normalized correlation coefficient
    const signalNorm = Math.sqrt(signalEnergy);
    const normalizer = templateNorm * signalNorm;

    if (normalizer > 0.001) {
      correlation[i] = dotProduct / normalizer;
    } else {
      correlation[i] = 0;
    }

    if (correlation[i] > peakValue) {
      peakValue = correlation[i];
      peakIndex = offset;
    }
  }

  return { correlation, peakIndex, peakValue };
}

/**
 * Detect chirp in audio signal using matched filter
 * Returns the sample index where the chirp ends (start of calibration tones)
 */
export function detectChirpSync(
  signal: Float32Array,
  sampleRate: number,
  threshold: number = 0.4
): { detected: boolean; chirpEndIndex: number; confidence: number } {
  const template = generatePreambleChirpTemplate(sampleRate);

  // Use larger step size for efficiency (we don't need sample-accurate detection initially)
  const stepSize = Math.floor(sampleRate / 100); // ~10ms steps

  const { peakIndex, peakValue } = correlateWithTemplate(signal, template, stepSize);

  if (peakValue >= threshold && peakIndex >= 0) {
    // Refine the peak position with smaller steps around the detected area
    const refineStart = Math.max(0, peakIndex - stepSize * 2);
    const refineEnd = Math.min(signal.length, peakIndex + stepSize * 2 + template.length);
    const refineSignal = signal.subarray(refineStart, refineEnd);

    const refined = correlateWithTemplate(refineSignal, template, 1);
    const refinedPeakIndex = refineStart + refined.peakIndex;

    // Chirp end is where the template ends
    const chirpEndIndex = refinedPeakIndex + template.length;

    return {
      detected: true,
      chirpEndIndex,
      confidence: refined.peakValue
    };
  }

  return { detected: false, chirpEndIndex: -1, confidence: peakValue };
}

/**
 * Incremental chirp detector for streaming audio
 * Maintains a buffer and detects chirp as audio comes in
 * Now detects which mode (phone/wideband) the chirp belongs to
 */
export class ChirpDetector {
  private sampleRate: number;
  private phoneTemplate: Float32Array;
  private widebandTemplate: Float32Array;
  private buffer: Float32Array;
  private bufferWritePos: number = 0;
  private bufferFilled: boolean = false;
  private detected: boolean = false;
  private chirpEndSample: number = -1;
  private confidence: number = 0;
  private detectedMode: AudioMode | null = null;
  private threshold: number;
  private lastCheckPos: number = 0;

  constructor(sampleRate: number, threshold: number = 0.35) {
    this.sampleRate = sampleRate;
    this.threshold = threshold;

    // Generate templates for both modes
    this.phoneTemplate = generatePreambleChirpTemplate(sampleRate, 'phone');
    this.widebandTemplate = generatePreambleChirpTemplate(sampleRate, 'wideband');

    // Buffer needs to hold at least 2x larger template length for detection
    const maxTemplateLen = Math.max(this.phoneTemplate.length, this.widebandTemplate.length);
    const bufferSize = maxTemplateLen * 3;
    this.buffer = new Float32Array(bufferSize);
  }

  /**
   * Add samples to the detector
   * Returns detection result including which mode was detected
   */
  addSamples(samples: Float32Array): { detected: boolean; chirpEndSample: number; confidence: number; mode: AudioMode | null } {
    if (this.detected) {
      return { detected: true, chirpEndSample: this.chirpEndSample, confidence: this.confidence, mode: this.detectedMode };
    }

    // Add samples to circular buffer
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.bufferWritePos] = samples[i];
      this.bufferWritePos = (this.bufferWritePos + 1) % this.buffer.length;
      if (this.bufferWritePos === 0) this.bufferFilled = true;
    }

    // Need at least template length to detect
    const availableSamples = this.bufferFilled ? this.buffer.length : this.bufferWritePos;
    const minRequired = Math.max(this.phoneTemplate.length, this.widebandTemplate.length) * 1.5;
    if (availableSamples < minRequired) {
      return { detected: false, chirpEndSample: -1, confidence: 0, mode: null };
    }

    // Linearize buffer for correlation
    const linearBuffer = this.getLinearBuffer();
    const stepSize = Math.floor(this.sampleRate / 50); // 20ms steps for speed

    // Try both templates and use the one with better correlation
    const phoneResult = correlateWithTemplate(linearBuffer, this.phoneTemplate, stepSize);
    const widebandResult = correlateWithTemplate(linearBuffer, this.widebandTemplate, stepSize);

    // Determine which mode matches better
    let bestMode: AudioMode;
    let bestTemplate: Float32Array;
    let bestResult: { peakIndex: number; peakValue: number };

    if (phoneResult.peakValue >= widebandResult.peakValue) {
      bestMode = 'phone';
      bestTemplate = this.phoneTemplate;
      bestResult = phoneResult;
    } else {
      bestMode = 'wideband';
      bestTemplate = this.widebandTemplate;
      bestResult = widebandResult;
    }

    if (bestResult.peakValue >= this.threshold) {
      // Refine detection
      const refineStart = Math.max(0, bestResult.peakIndex - stepSize);
      const refineEnd = Math.min(linearBuffer.length, bestResult.peakIndex + stepSize + bestTemplate.length);

      if (refineEnd <= linearBuffer.length) {
        const refineSignal = linearBuffer.subarray(refineStart, refineEnd);
        const refined = correlateWithTemplate(refineSignal, bestTemplate, 1);

        this.detected = true;
        this.chirpEndSample = refineStart + refined.peakIndex + bestTemplate.length;
        this.confidence = refined.peakValue;
        this.detectedMode = bestMode;

        console.log('[ChirpDetector] Chirp detected! Mode:', bestMode,
                    'Confidence:', this.confidence.toFixed(3),
                    'Phone:', phoneResult.peakValue.toFixed(3),
                    'Wideband:', widebandResult.peakValue.toFixed(3));

        return { detected: true, chirpEndSample: this.chirpEndSample, confidence: this.confidence, mode: bestMode };
      }
    }

    return { detected: false, chirpEndSample: -1, confidence: Math.max(phoneResult.peakValue, widebandResult.peakValue), mode: null };
  }

  /**
   * Get linear (non-circular) view of buffer
   */
  private getLinearBuffer(): Float32Array {
    if (!this.bufferFilled) {
      return this.buffer.subarray(0, this.bufferWritePos);
    }

    // Reorder circular buffer to linear
    const result = new Float32Array(this.buffer.length);
    const firstPartLen = this.buffer.length - this.bufferWritePos;
    result.set(this.buffer.subarray(this.bufferWritePos), 0);
    result.set(this.buffer.subarray(0, this.bufferWritePos), firstPartLen);
    return result;
  }

  /**
   * Reset detector state
   */
  reset(): void {
    this.bufferWritePos = 0;
    this.bufferFilled = false;
    this.detected = false;
    this.chirpEndSample = -1;
    this.confidence = 0;
    this.detectedMode = null;
    this.lastCheckPos = 0;
    this.buffer.fill(0);
  }

  /**
   * Check if chirp was detected
   */
  isDetected(): boolean {
    return this.detected;
  }

  /**
   * Get the sample index where calibration tones start (after chirp)
   */
  getChirpEndSample(): number {
    return this.chirpEndSample;
  }

  /**
   * Get detection confidence (0-1)
   */
  getConfidence(): number {
    return this.confidence;
  }

  /**
   * Get the detected audio mode (phone or wideband)
   */
  getDetectedMode(): AudioMode | null {
    return this.detectedMode;
  }
}
