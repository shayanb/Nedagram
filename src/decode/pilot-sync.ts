/**
 * Pilot Sync Detector for Music Steganography Mode
 *
 * Detects the MFSK pilot sequence in audio (with or without music),
 * providing timing alignment and mode detection as a replacement
 * for the chirp-based preamble detector.
 */
import { AUDIO, setAudioMode, getAudioMode, type AudioMode } from '../utils/constants';
import { PILOT_SEQUENCE_PHONE, PILOT_SEQUENCE_WIDEBAND } from '../encode/pilot';
import { detectToneSoft } from './soft-decision';

export interface PilotDetectionResult {
  detected: boolean;
  mode: AudioMode | null;
  /** Absolute sample index where the pilot+sync ends (header starts) */
  pilotEndSample: number;
  phase: number;
  confidence: number;
  matchRatio: number;
  symbolIndex: number;
}

const EMPTY_RESULT: PilotDetectionResult = {
  detected: false, mode: null, pilotEndSample: 0, phase: -1,
  confidence: 0, matchRatio: 0, symbolIndex: -1,
};

/**
 * Pilot Sync Detector
 */
export class PilotSyncDetector {
  private buffer: Float32Array;
  private bufferLength: number;
  private readonly sampleRate: number;
  private readonly detectionThreshold: number;
  private callCount: number = 0;
  private static readonly CHECK_INTERVAL = 5; // Only check every N calls

  constructor(sampleRate: number, threshold: number = 0.45) {
    this.sampleRate = sampleRate;
    this.detectionThreshold = threshold;
    this.buffer = new Float32Array(sampleRate * 60);
    this.bufferLength = 0;
  }

  addSamples(samples: Float32Array): PilotDetectionResult {
    // Append to buffer
    if (this.bufferLength + samples.length > this.buffer.length) {
      const newBuf = new Float32Array(this.buffer.length * 2);
      newBuf.set(this.buffer.subarray(0, this.bufferLength));
      this.buffer = newBuf;
    }
    this.buffer.set(samples, this.bufferLength);
    this.bufferLength += samples.length;

    // Need at least ~2s of audio
    if (this.bufferLength < this.sampleRate * 2) {
      return { ...EMPTY_RESULT };
    }

    // Only run detection periodically to reduce CPU load
    this.callCount++;
    if (this.callCount % PilotSyncDetector.CHECK_INTERVAL !== 0) {
      return { ...EMPTY_RESULT };
    }

    // Try both modes — always save/restore current mode to avoid side effects
    // on the main decoder's symbol extraction
    const originalMode = getAudioMode();
    let bestResult: PilotDetectionResult = { ...EMPTY_RESULT };

    for (const mode of ['phone', 'wideband'] as AudioMode[]) {
      setAudioMode(mode);
      const result = this.tryDetectMode(mode);
      if (result.detected && result.confidence > bestResult.confidence) {
        bestResult = result;
      }
    }

    // Always restore original mode — the caller (decoder) will set the
    // detected mode when it processes the result
    setAudioMode(originalMode);
    return bestResult;
  }

  private tryDetectMode(mode: AudioMode): PilotDetectionResult {
    const isPhone = mode === 'phone';
    const pilot = isPhone ? PILOT_SEQUENCE_PHONE : PILOT_SEQUENCE_WIDEBAND;
    const syncPattern = isPhone
      ? [0, 3, 0, 3, 0, 3, 0, 3]
      : [0, 15, 0, 15, 0, 15, 0, 15];
    const fullPattern = [...pilot, ...syncPattern];

    // Use AUDIO constants (now set to the correct mode)
    const symbolSamples = Math.floor((AUDIO.SYMBOL_DURATION_MS / 1000) * this.sampleRate);
    const guardSamples = Math.floor((AUDIO.GUARD_INTERVAL_MS / 1000) * this.sampleRate);
    const phaseOffset = Math.floor(symbolSamples / 4);

    const audio = this.buffer.subarray(0, this.bufferLength);

    let bestResult: PilotDetectionResult = { ...EMPTY_RESULT };

    for (let phase = 0; phase < 4; phase++) {
      const offset = phase * phaseOffset;

      // Extract symbols matching decoder's grid
      const symbols: number[] = [];
      let pos = offset;
      while (pos + symbolSamples <= this.bufferLength) {
        const guard = Math.floor(guardSamples / 2);
        const analysisStart = pos + guard;
        const analysisLen = symbolSamples - guard * 2;
        if (analysisStart + analysisLen > this.bufferLength) break;

        const window = audio.slice(analysisStart, analysisStart + analysisLen);
        const result = detectToneSoft(window, this.sampleRate, 0);
        symbols.push(result.hardDecision);

        pos += symbolSamples;
      }

      if (symbols.length < fullPattern.length) continue;

      // Sliding window correlation
      for (let i = 0; i <= symbols.length - fullPattern.length; i++) {
        let matches = 0;
        for (let j = 0; j < fullPattern.length; j++) {
          if (symbols[i + j] === fullPattern[j]) matches++;
        }

        const matchRatio = matches / fullPattern.length;

        if (matchRatio > this.detectionThreshold && matchRatio > bestResult.confidence) {
          const pilotEndSymbolIdx = i + fullPattern.length;
          const pilotEndSample = offset + pilotEndSymbolIdx * symbolSamples;

          bestResult = {
            detected: true,
            mode,
            pilotEndSample,
            phase,
            confidence: matchRatio,
            matchRatio,
            symbolIndex: i,
          };
        }
      }
    }

    return bestResult;
  }

  reset(): void {
    this.bufferLength = 0;
  }
}
