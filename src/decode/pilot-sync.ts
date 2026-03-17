/**
 * Pilot Sync Detector for Music Steganography Mode
 *
 * Detects the MFSK pilot sequence in audio (with or without music),
 * providing timing alignment and mode detection as a replacement
 * for the chirp-based preamble detector.
 */
import { AUDIO, TONE_FREQUENCIES, type AudioMode } from '../utils/constants';
import { PILOT_SEQUENCE_PHONE, PILOT_SEQUENCE_WIDEBAND, getFullPilotPattern } from '../encode/pilot';
import { detectToneSoft, type SoftDetectionResult } from './soft-decision';

export interface PilotDetectionResult {
  /** Whether the pilot was found with sufficient confidence */
  detected: boolean;
  /** Audio mode detected from pilot pattern */
  mode: AudioMode | null;
  /** Absolute sample index where the pilot ends (data starts after sync) */
  pilotEndSample: number;
  /** Best timing phase (0-3) */
  phase: number;
  /** Detection confidence (0-1) */
  confidence: number;
  /** Symbol match ratio (0-1) */
  matchRatio: number;
  /** Symbol index where the full pilot+sync pattern was found */
  symbolIndex: number;
}

/**
 * Pilot Sync Detector
 *
 * Continuously accumulates audio samples and attempts to find the
 * pilot sequence using soft-decision FFT detection + pattern correlation.
 */
export class PilotSyncDetector {
  private buffer: Float32Array;
  private bufferLength: number;
  private readonly sampleRate: number;
  private readonly detectionThreshold: number;

  constructor(sampleRate: number, threshold: number = 0.40) {
    this.sampleRate = sampleRate;
    this.detectionThreshold = threshold;
    // Buffer enough for ~60 seconds of audio
    this.buffer = new Float32Array(sampleRate * 60);
    this.bufferLength = 0;
  }

  /**
   * Add audio samples and attempt pilot detection
   */
  addSamples(samples: Float32Array): PilotDetectionResult {
    // Append to buffer
    if (this.bufferLength + samples.length > this.buffer.length) {
      // Grow buffer
      const newBuf = new Float32Array(this.buffer.length * 2);
      newBuf.set(this.buffer.subarray(0, this.bufferLength));
      this.buffer = newBuf;
    }
    this.buffer.set(samples, this.bufferLength);
    this.bufferLength += samples.length;

    // Need at least enough samples for the pilot pattern
    const minSymbols = 40; // pilot(24) + sync(8) + some margin
    const symbolSamples = Math.floor(
      (AUDIO.SYMBOL_DURATION_MS / 1000) * this.sampleRate
    );
    if (this.bufferLength < minSymbols * symbolSamples) {
      return { detected: false, mode: null, pilotEndSample: 0, phase: -1, confidence: 0, matchRatio: 0, symbolIndex: -1 };
    }

    // Try detection in both phone and wideband modes
    // First try current mode, then alternate
    const currentMode = AUDIO.NUM_TONES === 4 ? 'phone' : 'wideband';
    const modes: AudioMode[] = [currentMode, currentMode === 'phone' ? 'wideband' : 'phone'];

    for (const mode of modes) {
      const result = this.tryDetectMode(mode);
      if (result.detected) {
        return result;
      }
    }

    return { detected: false, mode: null, pilotEndSample: 0, phase: -1, confidence: 0, matchRatio: 0, symbolIndex: -1 };
  }

  private tryDetectMode(mode: AudioMode): PilotDetectionResult {
    // Get mode-specific parameters
    const isPhone = mode === 'phone';
    const pilot = isPhone ? PILOT_SEQUENCE_PHONE : PILOT_SEQUENCE_WIDEBAND;
    const syncPattern = isPhone
      ? [0, 3, 0, 3, 0, 3, 0, 3]
      : [0, 15, 0, 15, 0, 15, 0, 15];
    const fullPattern = [...pilot, ...syncPattern];

    const symbolDurationMs = isPhone ? 50 : 40;
    const guardMs = isPhone ? 12 : 5;
    // IMPORTANT: Match the decoder's symbol grid exactly
    // The decoder steps by symbolSamples (not symbol+guard), matching extractSymbolsAllPhases
    const symbolSamples = Math.floor((symbolDurationMs / 1000) * this.sampleRate);
    const guardSamples = Math.floor((guardMs / 1000) * this.sampleRate);

    const audio = this.buffer.subarray(0, this.bufferLength);

    // Try all 4 timing phases
    let bestResult: PilotDetectionResult = {
      detected: false, mode: null, pilotEndSample: 0, phase: -1,
      confidence: 0, matchRatio: 0, symbolIndex: -1,
    };

    // Phase offset matches decoder: symbolSamples / 4
    const phaseOffset = Math.floor(symbolSamples / 4);

    for (let phase = 0; phase < 4; phase++) {
      const offset = phase * phaseOffset;

      // Extract symbols using soft-decision detection
      // Step by symbolSamples (same as decoder's extractSymbolsAllPhases)
      const symbols: number[] = [];
      let pos = offset;
      while (pos + symbolSamples <= this.bufferLength) {
        // Skip guard at edges for cleaner detection
        const guard = Math.floor(guardSamples / 2);
        const analysisStart = pos + guard;
        const analysisLen = symbolSamples - guard * 2;
        if (analysisStart + analysisLen > this.bufferLength) break;

        const window = audio.slice(analysisStart, analysisStart + analysisLen);
        const result = detectToneSoft(window, this.sampleRate, 0);
        symbols.push(result.hardDecision);

        pos += symbolSamples; // Step by symbolSamples, matching decoder
      }

      if (symbols.length < fullPattern.length) continue;

      // Sliding window correlation against pilot pattern
      for (let i = 0; i <= symbols.length - fullPattern.length; i++) {
        let matches = 0;
        for (let j = 0; j < fullPattern.length; j++) {
          if (symbols[i + j] === fullPattern[j]) matches++;
        }

        const matchRatio = matches / fullPattern.length;
        const score = matchRatio;

        if (score > this.detectionThreshold && score > bestResult.confidence) {
          const pilotEndSymbolIdx = i + fullPattern.length;
          const pilotEndSample = offset + pilotEndSymbolIdx * symbolSamples;

          bestResult = {
            detected: true,
            mode,
            pilotEndSample,
            phase,
            confidence: score,
            matchRatio,
            symbolIndex: i,
          };
        }
      }
    }

    return bestResult;
  }

  /**
   * Reset the detector state
   */
  reset(): void {
    this.bufferLength = 0;
  }
}
