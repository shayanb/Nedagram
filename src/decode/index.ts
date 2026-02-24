/**
 * Main decoding pipeline
 *
 * Flow: Audio → Chirp detection → Symbol extraction → Sync → Decode
 *
 * Phase 2 improvement: Uses matched filter chirp detection for robust sync.
 * The chirp detector finds the preamble even in noisy conditions, then
 * precise timing is used to align symbol extraction.
 */
import { signal } from '@preact/signals';
import { AUDIO, FRAME_V3, PHONE_MODE, WIDEBAND_MODE, setAudioMode, getAudioMode, type AudioMode } from '../utils/constants';
import { bytesToString } from '../utils/helpers';
import { calculateSignalEnergy } from './detect';
import { detectToneSoft, softSymbolsToSoftBits, type SoftDetectionResult } from './soft-decision';
import { decodeDataFEC, decodeHeaderFEC, decodeHeaderWithRedundancy, decodeHeaderFECSoft, decodeDataFECSoft, decodeHeaderWithRedundancySoft, getHeaderSize, getDataFrameSize } from './fec';
import { parseHeaderFrame, parseDataFrame, FrameCollector, type HeaderInfo } from './deframe';
import { processPayload, type ProcessResult } from './decompress';
import { deinterleave, deinterleaveSoftBits, calculateInterleaverDepth } from '../encode/interleave';
import { sha256Hex } from '../lib/sha256';
import { ChirpDetector } from '../lib/chirp';
import { FrequencyOffsetTracker } from './freq-offset';

export type DecodeState =
  | 'idle'
  | 'listening'
  | 'detecting_preamble'
  | 'receiving_header'
  | 'receiving_data'
  | 'complete'
  | 'error';

export interface DecodeProgress {
  state: DecodeState;
  signalLevel: number;
  syncConfidence: number;
  framesReceived: number;
  totalFrames: number;
  errorsFixed: number;
  errorMessage?: string;
  debugInfo?: string;
  symbolsReceived?: number;
  chirpDetected?: boolean;  // True when preamble chirp is detected
  signalWarning?: boolean;  // True when repeated failures detected (poor signal quality)
}

export interface DecodeResult {
  data: Uint8Array;
  text: string;
  checksum: string;
  encrypted: boolean;
  needsPassword?: boolean;  // True if encrypted but no password provided
  stats: {
    originalSize: number;
    compressedSize: number;
    compressed: boolean;
    frameCount: number;
    errorsFixed: number;
  };
}

// Number of phase offsets to try (divide symbol into this many phases)
const NUM_PHASES = 4;

/**
 * Decoder class - handles the full decoding pipeline
 *
 * Uses multi-phase symbol extraction: tries multiple timing offsets
 * and finds the one that produces valid calibration + sync patterns.
 */
export class Decoder {
  private sampleRate: number;
  private frameCollector: FrameCollector;

  private state: DecodeState = 'idle';
  private headerInfo: HeaderInfo | null = null;
  private totalErrorsFixed = 0;
  private lastDebugInfo = '';
  private hasSignal = false;

  // Sample buffer for multi-phase extraction
  private sampleBuffer: Float32Array;
  private bufferWritePos = 0;
  private bufferFilled = false;
  private totalSamplesReceived = 0;

  // Symbol timing
  private symbolSamples: number;
  private guardSamples: number;
  private phaseOffset: number; // Samples to offset for correct phase

  // Multi-phase symbol extraction
  private phaseSymbols: number[][] = []; // Hard decisions for each phase (for pattern matching)
  private phaseSoftSymbols: SoftDetectionResult[][] = []; // Soft results for FEC decoding
  private bestPhase = -1;
  private syncFoundAt = -1;

  // Chirp detection (Phase 2: matched filter)
  private chirpDetector: ChirpDetector;
  private chirpDetected = false;
  private chirpEndSample = -1;  // Sample index where chirp ends (calibration starts)
  private lastPeakFreq = 0;
  private chirpSweepCount = 0;

  // Audio mode auto-detection
  private detectedAudioMode: AudioMode | null = null;
  private symbolExtractionMode: AudioMode | null = null; // Track which mode symbols were extracted with
  private lastExtractedSamplePos = 0; // Track extraction position for re-extraction

  // Encryption
  private password: string | null = null;
  private pendingPayload: Uint8Array | null = null;  // Raw payload awaiting decryption

  // Header failure detection
  private consecutiveHeaderFailures = 0;

  // Timeout detection
  private syncDetectedTime = 0;           // Timestamp when sync was found
  private headerDecodedTime = 0;          // Timestamp when header was decoded
  private expectedEndTime = 0;            // Expected transmission end time
  private lastHighEnergyTime = 0;         // Last time we saw significant audio energy
  private static readonly SILENCE_TIMEOUT_MS = 4000;    // 4 seconds of silence triggers timeout
  private static readonly ENERGY_THRESHOLD = 0.02;      // Below this is considered silence
  private static readonly MAX_HEADER_FAILURES = 5;  // After this many failures, warn user
  private static readonly FATAL_HEADER_FAILURES = 15; // After this many, give up and show error
  private modeRetryAttempted = false; // Track if we've tried the other mode
  private failedSyncPositions: Set<string> = new Set(); // Track failed sync positions to avoid retrying
  private headerOffsetRetries = 0; // Track position offset retries
  private static readonly MAX_OFFSET_RETRIES = 3; // Try ±1, ±2 symbol offsets

  // Data frame failure detection
  private failedDataFrames: Set<number> = new Set(); // Track frames that failed FEC
  private static readonly SYMBOL_BUFFER_RATIO = 1.5; // Wait for 50% more symbols than expected before failing

  // Salvage mode (relaxed thresholds, partial recovery)
  private salvageMode = false;

  // Frequency offset compensation (phone codec shifts)
  private freqOffsetTracker: FrequencyOffsetTracker;
  private estimatedFreqOffset: number = 0;

  // Spectral interference compensation (constant background tones)
  private toneBiases: Float32Array | null = null;

  // Protocol mismatch detection
  private suspectV2Protocol = false;

  // Performance throttling
  private patternSearchCounter = 0;
  private static readonly PATTERN_SEARCH_INTERVAL = 3; // Only search patterns every N audio chunks

  public progress = signal<DecodeProgress>({
    state: 'idle',
    signalLevel: 0,
    syncConfidence: 0,
    framesReceived: 0,
    totalFrames: 0,
    errorsFixed: 0,
    symbolsReceived: 0,
    chirpDetected: false,
  });

  private onComplete?: (result: DecodeResult) => void;
  private onError?: (error: Error) => void;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;
    this.symbolSamples = Math.floor((AUDIO.SYMBOL_DURATION_MS / 1000) * sampleRate);
    this.guardSamples = Math.floor((AUDIO.GUARD_INTERVAL_MS / 1000) * sampleRate);
    this.phaseOffset = Math.floor(this.symbolSamples / NUM_PHASES);
    this.frameCollector = new FrameCollector();

    // Buffer for ~60 seconds of audio (handles longer transmissions)
    // 60 sec * 48000 Hz = 2.88M samples = ~11.5 MB memory
    this.sampleBuffer = new Float32Array(60 * sampleRate);

    // Initialize chirp detector for robust preamble detection
    this.chirpDetector = new ChirpDetector(sampleRate, 0.3);

    // Frequency offset tracker (phone codecs can shift tones by 50-100+ Hz)
    this.freqOffsetTracker = new FrequencyOffsetTracker(200);

    // Initialize phase arrays (hard + soft)
    for (let p = 0; p < NUM_PHASES; p++) {
      this.phaseSymbols[p] = [];
      this.phaseSoftSymbols[p] = [];
    }
  }

  start(onComplete: (result: DecodeResult) => void, onError: (error: Error) => void): void {
    this.reset();
    this.state = 'listening';
    this.onComplete = onComplete;
    this.onError = onError;
    this.updateProgress();
  }

  stop(): void {
    this.state = 'idle';
    this.updateProgress();
  }

  /**
   * Set password for decrypting encrypted data
   */
  setPassword(password: string): void {
    this.password = password;
  }

  /**
   * Enable salvage mode for best-effort partial recovery
   * Relaxes thresholds and enables partial frame output
   */
  setSalvageMode(enabled: boolean): void {
    this.salvageMode = enabled;
  }

  /**
   * Get effective guard samples for symbol analysis.
   * In salvage mode, skip guard trimming entirely to maximize FFT window size.
   * Normal: 2400 - 2*576 = 1248 samples (52%), 38.5 Hz/bin resolution
   * Salvage: 2400 samples (100%), 20 Hz/bin resolution — matches analyzer behavior
   */
  private getEffectiveGuardSamples(): number {
    return this.salvageMode ? 0 : this.guardSamples;
  }

  /**
   * Retry decryption with a new password (after initial decode found encrypted data)
   * Throws error if decryption fails (wrong password)
   */
  async retryWithPassword(password: string): Promise<void> {
    if (!this.pendingPayload || !this.headerInfo) {
      throw new Error('No pending encrypted data to decrypt');
    }

    this.password = password;

    // Process payload directly instead of going through finalizeDecoding
    // to avoid triggering error handlers
    const result = await processPayload(
      this.pendingPayload,
      this.headerInfo.encrypted,
      this.headerInfo.compressed,
      this.headerInfo.compressionAlgo,
      this.headerInfo.originalLength,
      this.headerInfo.hasCrc32,
      password
    );

    if (!result.success || !result.data) {
      // Decryption failed - throw error for caller to handle
      throw new Error(result.error || 'Decryption failed');
    }

    // Decryption succeeded - complete the decode
    const data = result.data;
    const checksum = await sha256Hex(data);
    const text = bytesToString(data);

    this.state = 'complete';
    this.pendingPayload = null;
    this.updateProgress();

    console.log('[Decoder] Decryption successful! Data length:', data.length);

    this.onComplete?.({
      data,
      text,
      checksum,
      encrypted: this.headerInfo.encrypted,
      stats: {
        originalSize: this.headerInfo.originalLength,
        compressedSize: this.headerInfo.payloadLength,
        compressed: this.headerInfo.compressed,
        frameCount: this.headerInfo.totalFrames,
        errorsFixed: this.totalErrorsFixed,
      },
    });
  }

  reset(): void {
    this.state = 'idle';
    this.frameCollector.reset();
    this.headerInfo = null;
    this.totalErrorsFixed = 0;
    this.lastDebugInfo = '';
    this.hasSignal = false;
    this.bufferWritePos = 0;
    this.bufferFilled = false;
    this.totalSamplesReceived = 0;
    this.bestPhase = -1;
    this.syncFoundAt = -1;
    this.framesAttempted = new Set();
    this.failedDataFrames.clear();
    this.patternSearchCounter = 0;
    this.headerRepeated = false;
    this.chirpDetected = false;
    this.chirpEndSample = -1;
    this.chirpDetector.reset();
    this.lastPeakFreq = 0;
    this.chirpSweepCount = 0;
    this.detectedAudioMode = null;
    this.password = null;
    this.pendingPayload = null;
    this.consecutiveHeaderFailures = 0;
    this.syncDetectedTime = 0;
    this.headerDecodedTime = 0;
    this.expectedEndTime = 0;
    this.lastHighEnergyTime = 0;
    this.estimatedFreqOffset = 0;
    this.freqOffsetTracker.reset();
    this.toneBiases = null;

    for (let p = 0; p < NUM_PHASES; p++) {
      this.phaseSymbols[p] = [];
      this.phaseSoftSymbols[p] = [];
    }

    this.updateProgress();
  }

  processSamples(samples: Float32Array): void {
    if (this.state === 'idle' || this.state === 'complete' || this.state === 'error') return;

    // Calculate signal energy
    const energy = calculateSignalEnergy(samples, this.sampleRate);
    const signalLevel = Math.min(100, energy * 200);

    this.progress.value = { ...this.progress.value, signalLevel };

    // Track energy for silence detection
    const now = Date.now();
    if (energy > Decoder.ENERGY_THRESHOLD) {
      this.lastHighEnergyTime = now;
    }

    // Check for timeouts (only after sync is detected)
    if (this.syncDetectedTime > 0) {
      // Silence detection: if no significant audio for 4 seconds after sync (8s in salvage mode)
      const silenceTimeout = this.salvageMode ? Decoder.SILENCE_TIMEOUT_MS * 2 : Decoder.SILENCE_TIMEOUT_MS;
      if (this.lastHighEnergyTime > 0 && (now - this.lastHighEnergyTime) > silenceTimeout) {
        const silenceDuration = ((now - this.lastHighEnergyTime) / 1000).toFixed(1);
        console.log(`[Decoder] Silence timeout: ${silenceDuration}s of silence detected`);
        this.handleTimeoutError(`Transmission ended (${silenceDuration}s silence). No complete message received.`);
        return;
      }

      // Expected duration timeout: if we've exceeded expected transmission time by 50%
      if (this.expectedEndTime > 0 && now > this.expectedEndTime) {
        const elapsed = ((now - this.headerDecodedTime) / 1000).toFixed(1);
        console.log(`[Decoder] Duration timeout: expected end time exceeded (${elapsed}s elapsed)`);
        this.handleTimeoutError(`Transmission taking too long (${elapsed}s). Expected ${this.headerInfo?.totalFrames || '?'} frames.`);
        return;
      }
    }

    // Add samples to buffer
    for (let i = 0; i < samples.length; i++) {
      this.sampleBuffer[this.bufferWritePos] = samples[i];
      this.bufferWritePos = (this.bufferWritePos + 1) % this.sampleBuffer.length;
      if (this.bufferWritePos === 0) this.bufferFilled = true;
    }
    this.totalSamplesReceived += samples.length;

    // Check for signal presence
    if (!this.hasSignal && energy > 0.05) {
      this.hasSignal = true;
      this.state = 'detecting_preamble';
      console.log('[Decoder] Signal detected');
    }

    if (!this.hasSignal) {
      this.lastDebugInfo = `Waiting for signal (energy: ${energy.toFixed(3)})`;
      this.updateProgress();
      return;
    }

    // Phase 2: Use matched filter chirp detection for robust sync
    if (!this.chirpDetected && this.state === 'detecting_preamble') {
      const chirpResult = this.chirpDetector.addSamples(samples);
      if (chirpResult.detected) {
        this.chirpDetected = true;
        this.chirpEndSample = chirpResult.chirpEndSample;

        // Set mode from chirp detection BEFORE symbol extraction continues
        // This ensures symbols get extracted with correct timing for the detected mode
        if (chirpResult.mode) {
          console.log('[Decoder] Chirp detected mode:', chirpResult.mode, 'Confidence:', chirpResult.confidence.toFixed(3));
          this.detectedAudioMode = chirpResult.mode;
          setAudioMode(chirpResult.mode);
          this.updateSymbolTiming(); // This clears wrongly-extracted symbols if mode changed
        } else {
          console.log('[Decoder] Chirp detected via matched filter! Confidence:', chirpResult.confidence.toFixed(3));
        }
        this.lastDebugInfo = `Chirp detected (${chirpResult.mode || 'unknown'}, ${(chirpResult.confidence * 100).toFixed(0)}% confidence)`;
      } else if (chirpResult.confidence > 0.15) {
        this.lastDebugInfo = `Searching for chirp... (${(chirpResult.confidence * 100).toFixed(0)}% match)`;
      }
    }

    // Extract symbols for all phases
    try {
      this.extractSymbolsAllPhases();
    } catch (err) {
      console.error('[Decoder] extractSymbolsAllPhases error:', err);
      this.lastDebugInfo = `Error: extractSymbols - ${err instanceof Error ? err.message : err}`;
      this.updateProgress();
      return;
    }

    // Process based on state
    try {
      if (this.bestPhase < 0) {
        // Throttle pattern search to reduce CPU load during preamble detection
        this.patternSearchCounter++;
        if (this.patternSearchCounter >= Decoder.PATTERN_SEARCH_INTERVAL) {
          this.patternSearchCounter = 0;
          // If chirp is detected, use precise timing first
          if (this.chirpDetected && this.chirpEndSample > 0) {
            this.findBestPhaseFromChirp();
          }
          // If chirp-based search didn't find sync (or no chirp), use exhaustive search
          if (this.bestPhase < 0) {
            this.findBestPhase();
          }
        }
      } else if (this.state === 'receiving_header') {
        this.processHeader();
      } else if (this.state === 'receiving_data') {
        this.processDataFrame();
      }
    } catch (err) {
      console.error('[Decoder] Processing error:', err);
      this.lastDebugInfo = `Error: processing - ${err instanceof Error ? err.message : err}`;
    }

    this.updateProgress();
  }

  private extractSymbolsAllPhases(): void {
    // Track which mode we're extracting symbols for
    if (!this.symbolExtractionMode) {
      this.symbolExtractionMode = getAudioMode();
    }

    // Calculate the oldest valid sample position (buffer is circular)
    // We can only reliably read samples that haven't been overwritten
    const bufferLen = this.sampleBuffer.length;
    const oldestValidSample = this.totalSamplesReceived > bufferLen
      ? this.totalSamplesReceived - bufferLen
      : 0;

    // Once we've found the best phase, only extract for that phase to save computation
    const phasesToProcess = this.bestPhase >= 0 ? [this.bestPhase] : Array.from({ length: NUM_PHASES }, (_, i) => i);

    for (const phase of phasesToProcess) {
      const offset = phase * this.phaseOffset;
      const symbolsExpected = Math.floor((this.totalSamplesReceived - offset) / this.symbolSamples);

      while (this.phaseSymbols[phase].length < symbolsExpected) {
        const symbolIndex = this.phaseSymbols[phase].length;
        const symbolStart = offset + symbolIndex * this.symbolSamples;

        // Get samples for this symbol (skip guard intervals; salvage mode uses full window)
        const guard = this.getEffectiveGuardSamples();
        const analysisStart = symbolStart + guard;
        const analysisLength = this.symbolSamples - guard * 2;

        // Check if we have enough samples
        if (analysisStart + analysisLength > this.totalSamplesReceived) break;

        // CRITICAL: Check if the data is still valid (not overwritten by buffer wrap)
        if (analysisStart < oldestValidSample) {
          // This symbol's data has been overwritten - we've fallen behind!
          // This should not happen in normal operation, but if it does,
          // push a placeholder and log a warning
          console.warn('[Decoder] Buffer overflow! Symbol', symbolIndex, 'data was overwritten. Behind by',
            oldestValidSample - analysisStart, 'samples');
          this.phaseSymbols[phase].push(0); // Placeholder - will likely cause decode failure
          // Push uncertain soft result to maintain alignment
          const numTones = AUDIO.NUM_TONES || 4;
          this.phaseSoftSymbols[phase].push({
            softValues: new Uint8Array(numTones).fill(127),
            hardDecision: 0,
            confidence: 0,
          });
          continue;
        }

        const symbolSamples = this.getBufferSamples(analysisStart, analysisLength);

        // Use soft-decision detection: provides both hard decision for pattern
        // matching and soft confidence values for Viterbi FEC decoding (~2-3 dB gain)
        const softResult = detectToneSoft(symbolSamples, this.sampleRate, this.estimatedFreqOffset, this.toneBiases ?? undefined);
        const confidenceThreshold = this.salvageMode ? 0.02 : 0.10;

        // Store hard decision for pattern matching (findBestPhase, etc.)
        if (softResult.confidence >= confidenceThreshold) {
          this.phaseSymbols[phase].push(softResult.hardDecision);
        } else {
          // Low confidence - still push hard decision to maintain alignment
          this.phaseSymbols[phase].push(softResult.hardDecision);
        }

        // Store soft result for FEC decoding (without magnitudes to save memory)
        this.phaseSoftSymbols[phase].push({
          softValues: softResult.softValues,
          hardDecision: softResult.hardDecision,
          confidence: softResult.confidence,
        });
      }
    }
  }

  /**
   * Extract soft bits for a slice of symbols (for soft-decision FEC decoding)
   */
  private extractSoftBitsForSlice(
    phase: number,
    startIndex: number,
    symbolCount: number,
    expectedBytes: number
  ): number[] | null {
    const softResults = this.phaseSoftSymbols[phase];
    if (!softResults || softResults.length < startIndex + symbolCount) {
      return null;
    }
    const slice = softResults.slice(startIndex, startIndex + symbolCount);
    const softBits = softSymbolsToSoftBits(slice, AUDIO.BITS_PER_SYMBOL);
    // Trim to expected byte boundary
    return softBits.slice(0, expectedBytes * 8);
  }

  private getBufferSamples(startSample: number, length: number): Float32Array {
    const result = new Float32Array(length);
    const bufferLen = this.sampleBuffer.length;

    for (let i = 0; i < length; i++) {
      // Calculate position in circular buffer
      // startSample is absolute, need to map to buffer position
      const absolutePos = startSample + i;
      const bufferPos = absolutePos % bufferLen;
      result[i] = this.sampleBuffer[bufferPos];
    }

    return result;
  }

  /**
   * Phase 2: Use precise chirp timing to find symbol boundaries
   *
   * When chirp is detected via matched filter, we know exactly where it ends.
   * From there, we can calculate where calibration and sync start, giving us
   * precise symbol alignment without needing to search through multiple phases.
   */
  private findBestPhaseFromChirp(): void {
    if (this.chirpEndSample <= 0) return;

    // After chirp: warmup tone was before chirp, now we have calibration tones
    // Structure: [warmup][chirp][calibration x2][sync x8][header][data...]
    //                         ^-- chirpEndSample points here

    const calibrationRepeats = AUDIO.CALIBRATION_REPEATS || 2;
    const calibrationSymbols = AUDIO.CALIBRATION_TONES.length * calibrationRepeats;
    const syncSymbols = AUDIO.SYNC_PATTERN.length;

    // Calculate where header starts (after calibration + sync)
    const symbolDurationSamples = this.symbolSamples;
    const headerStartSample = this.chirpEndSample +
      (calibrationSymbols + syncSymbols) * symbolDurationSamples;

    // Calculate which phase aligns best with this timing
    const sampleOffset = headerStartSample % symbolDurationSamples;
    const bestPhaseEstimate = Math.round(sampleOffset / this.phaseOffset) % NUM_PHASES;

    // Verify by checking if we can detect calibration/sync pattern at this alignment
    const symbols = this.phaseSymbols[bestPhaseEstimate];

    // Calculate which symbol index corresponds to the start of calibration
    const calibStartSymbolIndex = Math.floor(this.chirpEndSample / symbolDurationSamples);

    // Check if we have enough symbols
    if (symbols.length < calibStartSymbolIndex + calibrationSymbols + syncSymbols + 10) {
      this.lastDebugInfo = `Chirp found, waiting for symbols... (${symbols.length}/${calibStartSymbolIndex + 20})`;
      return;
    }

    // Try to match calibration + sync pattern starting from the calculated position
    // Try both phone and wideband modes
    const modes: { mode: AudioMode; calib: number[]; sync: number[]; maxTone: number }[] = [
      {
        mode: 'phone',
        calib: PHONE_MODE.CALIBRATION_TONES,
        sync: PHONE_MODE.SYNC_PATTERN,
        maxTone: PHONE_MODE.NUM_TONES - 1,
      },
      {
        mode: 'wideband',
        calib: WIDEBAND_MODE.CALIBRATION_TONES,
        sync: WIDEBAND_MODE.SYNC_PATTERN,
        maxTone: WIDEBAND_MODE.NUM_TONES - 1,
      },
    ];

    // Search in a small window around the estimated position (±3 symbols)
    for (let offset = -3; offset <= 3; offset++) {
      const startIdx = calibStartSymbolIndex + offset;
      if (startIdx < 0 || startIdx + calibrationSymbols + syncSymbols >= symbols.length) continue;

      for (const { mode, calib, sync, maxTone } of modes) {
        // Build expected pattern: calibration repeated + sync
        const fullCalib: number[] = [];
        for (let r = 0; r < calibrationRepeats; r++) {
          fullCalib.push(...calib);
        }
        const fullPattern = [...fullCalib, ...sync];

        // Check pattern match
        let matchCount = 0;
        const tolerance = maxTone > 10 ? 2 : 1;

        for (let i = 0; i < fullPattern.length; i++) {
          const expected = fullPattern[i];
          const actual = symbols[startIdx + i];
          if (actual === expected || Math.abs(actual - expected) <= tolerance) {
            matchCount++;
          }
        }

        const matchRatio = matchCount / fullPattern.length;

        const matchThreshold = this.salvageMode ? 0.50 : 0.70;
        if (matchRatio >= matchThreshold) {  // Relaxed in salvage mode
          this.bestPhase = bestPhaseEstimate;
          this.syncFoundAt = startIdx + fullPattern.length;
          this.detectedAudioMode = mode;
          this.state = 'receiving_header';
          this.syncDetectedTime = Date.now();
          this.lastHighEnergyTime = Date.now();  // Reset silence timer

          setAudioMode(mode);
          this.updateSymbolTiming();

          console.log('[Decoder] Chirp-aligned sync found! Mode:', mode,
                      'Phase:', bestPhaseEstimate, 'Match:', (matchRatio * 100).toFixed(0) + '%');
          this.lastDebugInfo = `Sync found via chirp (${mode}, ${(matchRatio * 100).toFixed(0)}% match)`;
          return;
        }
      }
    }

    // If chirp-based alignment didn't find pattern, fall back to exhaustive search
    this.lastDebugInfo = 'Chirp found, searching for sync pattern...';
  }

  /**
   * Check if a sync position has already been tried and failed
   */
  private isSyncPositionFailed(phase: number, syncFoundAt: number): boolean {
    // Check exact position and nearby positions (±2)
    for (let offset = -2; offset <= 2; offset++) {
      const key = `${phase}:${syncFoundAt + offset}`;
      if (this.failedSyncPositions.has(key)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Mark a sync position as failed
   */
  private markSyncPositionFailed(phase: number, syncFoundAt: number): void {
    const key = `${phase}:${syncFoundAt}`;
    this.failedSyncPositions.add(key);
    console.log('[Decoder] Marked sync position as failed:', key);
  }

  private findBestPhase(): void {
    // Try to detect both phone and wideband patterns
    // New preamble: calibration (repeated 2x) + sync (8 symbols)
    // Phone: calib [0,2,5,7] x2 = 8 symbols, sync [0,7,0,7,0,7,0,7] = 8 symbols
    // Wideband: calib [0,5,10,15] x2 = 8 symbols, sync [0,15,0,15,0,15,0,15] = 8 symbols

    const calibRepeats = 2;

    const modes: { mode: AudioMode; calib: number[]; sync: number[]; maxTone: number }[] = [
      {
        mode: 'phone',
        calib: PHONE_MODE.CALIBRATION_TONES,
        sync: PHONE_MODE.SYNC_PATTERN,
        maxTone: PHONE_MODE.NUM_TONES - 1,
      },
      {
        mode: 'wideband',
        calib: WIDEBAND_MODE.CALIBRATION_TONES,
        sync: WIDEBAND_MODE.SYNC_PATTERN,
        maxTone: WIDEBAND_MODE.NUM_TONES - 1,
      },
    ];

    // Search in order of match quality: full pattern > sync-only > loose
    // This ensures we find the best match across ALL phases before falling back

    // PASS 1: Try full calibration+sync pattern (16 symbols) - most reliable
    for (let phase = 0; phase < NUM_PHASES; phase++) {
      const symbols = this.phaseSymbols[phase];
      if (symbols.length < 20) continue;

      for (const { mode, calib, sync, maxTone } of modes) {
        const fullCalib: number[] = [];
        for (let r = 0; r < calibRepeats; r++) {
          fullCalib.push(...calib);
        }
        const fullPattern = [...fullCalib, ...sync];
        const patternLen = fullPattern.length;

        for (let i = 0; i <= symbols.length - patternLen; i++) {
          const syncPos = i + patternLen;
          if (this.isSyncPositionFailed(phase, syncPos)) continue;

          if (this.matchesPatternForMode(symbols, i, fullPattern, maxTone, this.salvageMode)) {
            this.bestPhase = phase;
            this.syncFoundAt = syncPos;
            this.state = 'receiving_header';
            this.detectedAudioMode = mode;
            this.syncDetectedTime = Date.now();
            this.lastHighEnergyTime = Date.now();  // Reset silence timer

            // Set the audio mode globally
            setAudioMode(mode);
            this.updateSymbolTiming();

            console.log(`[Decoder] Found ${mode} calibration+sync at phase ${phase} index ${i} (${symbols.slice(i, i + patternLen).join(',')})`);
            this.lastDebugInfo = `Sync found (${mode} mode)! Receiving header...`;
            return;
          }
        }
      }
    }

    // PASS 2: Try sync-only pattern (8 symbols) - fallback
    for (let phase = 0; phase < NUM_PHASES; phase++) {
      const symbols = this.phaseSymbols[phase];
      if (symbols.length < 20) continue;

      for (const { mode, sync, maxTone } of modes) {
        const syncLen = sync.length;
        for (let i = 0; i <= symbols.length - syncLen; i++) {
          const syncPos = i + syncLen;
          if (this.isSyncPositionFailed(phase, syncPos)) continue;

          if (this.matchesSyncPatternForMode(symbols, i, maxTone, syncLen, this.salvageMode)) {
            if (symbols.length > syncPos + 12) {
              this.bestPhase = phase;
              this.syncFoundAt = syncPos;
              this.state = 'receiving_header';
              this.detectedAudioMode = mode;
              this.syncDetectedTime = Date.now();
              this.lastHighEnergyTime = Date.now();  // Reset silence timer

              setAudioMode(mode);
              this.updateSymbolTiming();

              console.log('[Decoder] Found', mode, 'sync-only at phase', phase, 'index', i);
              console.log('[Decoder] Pattern:', symbols.slice(i, i + syncLen));
              this.lastDebugInfo = `Sync found (${mode}, sync-only)!`;
              return;
            }
          }
        }
      }
    }

    // PASS 3: Try loose pattern (8 symbols with tolerance) - last resort
    // Skip in salvage mode: PASS 4's full 16-symbol best-match search is more reliable
    // because the 8-symbol pattern has ambiguous alignment (calib[0] vs calib[4])
    if (!this.salvageMode) {
      for (let phase = 0; phase < NUM_PHASES; phase++) {
        const symbols = this.phaseSymbols[phase];
        if (symbols.length < 20) continue;

        for (const { mode, maxTone } of modes) {
          for (let i = 0; i <= symbols.length - 8; i++) {
            // The loose pattern [0,1,2,3,0,3,0,3] matches calib[4..7]+sync[0..3].
            // After these 8 symbols, sync[4..7] (4 more symbols) remain before header.
            const syncPos = i + 12;
            if (this.isSyncPositionFailed(phase, syncPos)) continue;

            // Require enough symbols that a full pattern at i-4 would have been detectable
            // Full pattern at (i-4) needs symbols up to (i-4+16) = (i+12)
            // This prevents matching a loose pattern before its containing full pattern is visible
            if (symbols.length < i + 16) continue;

            if (this.matchesLoosePatternForMode(symbols, i, maxTone, this.salvageMode)) {
              this.bestPhase = phase;
              this.syncFoundAt = syncPos;
              this.state = 'receiving_header';
              this.detectedAudioMode = mode;
              this.syncDetectedTime = Date.now();
              this.lastHighEnergyTime = Date.now();  // Reset silence timer

              setAudioMode(mode);
              this.updateSymbolTiming();

              console.log(`[Decoder] Found ${mode} loose pattern at phase ${phase} index ${i} (${symbols.slice(i, i + 8).join(',')})`);
              this.lastDebugInfo = `Sync found (${mode}, loose)!`;
              return;
            }
          }
        }
      }
    }

    // PASS 4 (salvage only): Percentage-based pattern scan — like the analyzer
    // Uses a lower threshold (60%) to find heavily distorted preambles
    if (this.salvageMode) {
      let bestMatch = { ratio: 0, phase: -1, syncPos: -1, mode: '' as AudioMode };

      for (let phase = 0; phase < NUM_PHASES; phase++) {
        const symbols = this.phaseSymbols[phase];
        if (symbols.length < 20) continue;

        for (const { mode, calib, sync, maxTone } of modes) {
          const fullCalib: number[] = [];
          for (let r = 0; r < calibRepeats; r++) {
            fullCalib.push(...calib);
          }
          const fullPattern = [...fullCalib, ...sync];
          const patternLen = fullPattern.length;
          const tolerance = maxTone > 10 ? 2 : 1;

          for (let i = 0; i <= symbols.length - patternLen; i++) {
            const syncPos = i + patternLen;
            if (this.isSyncPositionFailed(phase, syncPos)) continue;
            if (symbols.length < syncPos + 12) continue; // Need some header symbols too

            let matchCount = 0;
            for (let j = 0; j < patternLen; j++) {
              if (symbols[i + j] === fullPattern[j] ||
                  Math.abs(symbols[i + j] - fullPattern[j]) <= tolerance) {
                matchCount++;
              }
            }
            const ratio = matchCount / patternLen;
            if (ratio > bestMatch.ratio) {
              bestMatch = { ratio, phase, syncPos, mode };
            }
          }
        }
      }

      // Require enough symbols before accepting low-confidence matches.
      // The preamble might be further into the audio, and with incremental feeding
      // (100ms chunks), we might prematurely lock onto a false match before the real
      // preamble has been fully extracted. Require 80 symbols (~4s) for matches <75%
      // to ensure the full preamble region has been processed.
      const minSymbolsForLowMatch = 80;
      const maxPhaseSymbols = Math.max(...this.phaseSymbols.map(s => s.length));
      const acceptThreshold = maxPhaseSymbols >= minSymbolsForLowMatch ? 0.60 : 0.80;

      if (bestMatch.ratio >= acceptThreshold && bestMatch.phase >= 0) {
        this.bestPhase = bestMatch.phase;
        this.syncFoundAt = bestMatch.syncPos;
        this.state = 'receiving_header';
        this.detectedAudioMode = bestMatch.mode as AudioMode;
        this.syncDetectedTime = Date.now();
        this.lastHighEnergyTime = Date.now();

        setAudioMode(bestMatch.mode as AudioMode);
        this.updateSymbolTiming();

        console.log(`[Decoder] Salvage: found ${bestMatch.mode} pattern at phase ${bestMatch.phase} syncPos ${bestMatch.syncPos} (${(bestMatch.ratio * 100).toFixed(0)}% match)`);
        this.lastDebugInfo = `Sync found (${bestMatch.mode}, salvage ${(bestMatch.ratio * 100).toFixed(0)}%)!`;
        return;
      }
    }

    // Show debug info about what we're seeing
    const bestPhaseSymbols = this.phaseSymbols[0];
    const recent = bestPhaseSymbols.slice(-20);
    this.lastDebugInfo = `Detecting preamble... ${bestPhaseSymbols.length} symbols, recent: [${recent.join(',')}]`;
  }

  /**
   * Update symbol timing after mode detection
   * If mode changed from what symbols were extracted with, clear and re-extract
   */
  private updateSymbolTiming(): void {
    const oldMode = this.symbolExtractionMode;
    const newMode = this.detectedAudioMode;

    this.symbolSamples = Math.floor((AUDIO.SYMBOL_DURATION_MS / 1000) * this.sampleRate);
    this.guardSamples = Math.floor((AUDIO.GUARD_INTERVAL_MS / 1000) * this.sampleRate);
    this.phaseOffset = Math.floor(this.symbolSamples / NUM_PHASES);

    console.log('[Decoder] Updated timing for', newMode, '- symbol:', this.symbolSamples, 'samples');

    // If mode changed, we need to re-extract symbols with new timing
    if (oldMode && oldMode !== newMode) {
      console.log('[Decoder] Mode changed from', oldMode, 'to', newMode, '- re-extracting symbols');
      this.clearSymbolsForReextraction();
    }

    this.symbolExtractionMode = newMode;
  }

  /**
   * Clear symbols and reset for re-extraction with new timing
   */
  private clearSymbolsForReextraction(): void {
    // Clear all phase symbol arrays (hard + soft)
    for (let p = 0; p < NUM_PHASES; p++) {
      this.phaseSymbols[p] = [];
      this.phaseSoftSymbols[p] = [];
    }
    // Reset detection state
    this.bestPhase = -1;
    this.syncFoundAt = -1;
    this.state = 'detecting_preamble';
    // Reset extraction mode so next extraction uses current timing
    this.symbolExtractionMode = null;
    // Keep chirp detection state as the chirp position is still valid
  }

  /**
   * Estimate frequency offset from calibration tones using the chirp end position.
   * Calibration tones have known values, so we can measure how much the phone codec
   * has shifted the frequencies and compensate during symbol detection.
   */
  private estimateFreqOffsetFromCalibration(): void {
    const calibrationRepeats = AUDIO.CALIBRATION_REPEATS || 2;
    const calibTones = AUDIO.CALIBRATION_TONES;
    const calibSymbolCount = calibTones.length * calibrationRepeats;
    const calibSampleCount = calibSymbolCount * this.symbolSamples;

    let calibStartSample: number;

    if (this.chirpEndSample > 0) {
      // Method 1: Use chirp end position (most accurate)
      calibStartSample = this.chirpEndSample;
    } else if (this.syncFoundAt >= 0 && this.bestPhase >= 0) {
      // Method 2: Derive from sync position
      // syncFoundAt = first header symbol index
      // Calibration is calibSymbolCount symbols before sync pattern (8 sync symbols)
      const syncLen = AUDIO.SYNC_PATTERN.length;
      const calibSymbolIdx = this.syncFoundAt - syncLen - calibSymbolCount;
      if (calibSymbolIdx < 0) return;
      calibStartSample = this.bestPhase * this.phaseOffset + calibSymbolIdx * this.symbolSamples;
    } else {
      return;
    }

    if (calibStartSample + calibSampleCount > this.totalSamplesReceived) return;
    if (calibStartSample < 0) return;

    const calibSamples = this.getBufferSamples(calibStartSample, calibSampleCount);

    // Build expected tone sequence: [0,1,2,3, 0,1,2,3] for phone
    const expectedTones: number[] = [];
    for (let r = 0; r < calibrationRepeats; r++) {
      expectedTones.push(...calibTones);
    }

    const result = this.freqOffsetTracker.estimateOffset(
      calibSamples, this.sampleRate, expectedTones, this.symbolSamples
    );

    this.estimatedFreqOffset = result.offsetHz;
    console.log(`[Decoder] Frequency offset: ${result.offsetHz.toFixed(1)} Hz (confidence: ${(result.confidence * 100).toFixed(0)}%)`);
    if (result.measurements.length > 0) {
      for (const m of result.measurements) {
        console.log(`[Decoder]   Tone ${m.expectedHz}Hz -> measured ${m.measuredHz.toFixed(0)}Hz (${m.errorHz >= 0 ? '+' : ''}${m.errorHz.toFixed(0)}Hz)`);
      }
    }

    // If significant offset detected, re-extract symbols from sync position onward
    this.reextractWithOffset();
  }


  /**
   * Re-extract symbols from sync position onward with the estimated frequency offset.
   * Called after frequency offset is estimated from calibration tones.
   */
  private reextractWithOffset(): void {
    if (Math.abs(this.estimatedFreqOffset) < 5) return; // No significant offset

    console.log(`[Decoder] Re-extracting symbols with offset ${this.estimatedFreqOffset.toFixed(1)} Hz`);
    for (let p = 0; p < NUM_PHASES; p++) {
      if (this.phaseSymbols[p].length > this.syncFoundAt) {
        this.phaseSymbols[p] = this.phaseSymbols[p].slice(0, this.syncFoundAt);
        this.phaseSoftSymbols[p] = this.phaseSoftSymbols[p].slice(0, this.syncFoundAt);
      }
    }
    // Re-extraction happens naturally in the next extractSymbolsAllPhases() call
    // since phaseSymbols.length < symbolsExpected, using the now-set estimatedFreqOffset
  }

  /**
   * Estimate per-tone interference levels from global audio analysis.
   *
   * Scans symbols across the entire audio and measures the MINIMUM magnitude
   * of each tone. A constant interfering frequency (e.g., 1800 Hz from codec
   * artifacts or speaker resonance) will have a high minimum because it never
   * drops to zero, unlike legitimate signal tones which are only present when
   * that specific tone is being transmitted.
   *
   * This approach is position-independent — it doesn't need the correct
   * calibration position to detect interference.
   *
   * Returns true if significant interference was detected and biases were set.
   */
  private estimateToneBiases(): boolean {
    const phase = this.bestPhase >= 0 ? this.bestPhase : 0;
    const offset = phase * this.phaseOffset;
    const numTones = AUDIO.NUM_TONES || 4;

    // Sample symbols near the sync position (where we know there's signal)
    // Use a window centered around syncFoundAt, extending backwards and forwards
    const syncIdx = this.syncFoundAt >= 0 ? this.syncFoundAt : 0;
    const totalSymbols = Math.floor((this.totalSamplesReceived - offset) / this.symbolSamples);
    // Start from 20 symbols before sync (in the calibration/preamble region) to well into the data
    const sampleStart = Math.max(0, syncIdx - 20);
    const sampleEnd = Math.min(totalSymbols, syncIdx + 200);
    const numAvailable = sampleEnd - sampleStart;
    const numToSample = Math.min(50, numAvailable);
    if (numToSample < 10) return false;

    // For each tone, measure its average magnitude when it's NOT the hard decision
    // (i.e., when another tone won). This isolates the interference baseline.
    const step = Math.max(1, Math.floor(numAvailable / numToSample));
    const noiseSums = new Float32Array(numTones);
    const noiseCounts = new Float32Array(numTones);
    let validCount = 0;

    const biasGuard = this.getEffectiveGuardSamples();
    for (let idx = sampleStart; idx < sampleEnd && validCount < numToSample; idx += step) {
      const symbolStart = offset + idx * this.symbolSamples;
      const analysisStart = symbolStart + biasGuard;
      const analysisLength = this.symbolSamples - biasGuard * 2;

      if (analysisStart + analysisLength > this.totalSamplesReceived) break;

      const samples = this.getBufferSamples(analysisStart, analysisLength);
      const result = detectToneSoft(samples, this.sampleRate, this.estimatedFreqOffset);
      if (!result.magnitudes) continue;

      // Skip very low energy symbols (silence/noise)
      const maxMag = Math.max(...result.magnitudes);
      if (maxMag < 3) continue;

      const winner = result.hardDecision;
      for (let t = 0; t < numTones; t++) {
        if (t !== winner) {
          noiseSums[t] += result.magnitudes[t];
          noiseCounts[t] += 1;
        }
      }
      validCount++;
    }

    if (validCount < 5) {
      console.log(`[Decoder] Tone bias: insufficient samples (${validCount})`);
      return false;
    }

    // Compute average "background" magnitude per tone
    const avgNoise = new Float32Array(numTones);
    for (let t = 0; t < numTones; t++) {
      avgNoise[t] = noiseCounts[t] > 0 ? noiseSums[t] / noiseCounts[t] : 0;
    }

    // Find tone with highest average noise (constant interference)
    let maxNoise = 0;
    let maxIdx = -1;
    for (let t = 0; t < numTones; t++) {
      if (avgNoise[t] > maxNoise) {
        maxNoise = avgNoise[t];
        maxIdx = t;
      }
    }

    // Compare against other tones' average noise
    let otherSum = 0;
    let otherCount = 0;
    for (let t = 0; t < numTones; t++) {
      if (t !== maxIdx) {
        otherSum += avgNoise[t];
        otherCount++;
      }
    }
    const otherAvg = otherCount > 0 ? otherSum / otherCount : 0;

    if (maxNoise < otherAvg * 1.3 || maxNoise < 3) {
      return false;
    }

    // Use full average noise as bias for spectral whitening (division-based)
    const biases = new Float32Array(numTones);
    for (let t = 0; t < numTones; t++) {
      biases[t] = avgNoise[t];
    }

    this.toneBiases = biases;
    console.log(`[Decoder] Spectral interference: tone ${maxIdx} noise ${maxNoise.toFixed(1)} (${(maxNoise/otherAvg).toFixed(1)}x others)`);

    return true;
  }

  /**
   * Frequency sweep header decode: try different frequency offsets to recover
   * the header. Used in salvage mode when standard decoding fails.
   * Sweeps -100 to +100 Hz in 10 Hz steps, re-extracting symbols from raw audio
   * at each offset and attempting FEC decode.
   */
  private frequencySweepHeaderDecode(headerBytes: number, headerSymbols: number): boolean {
    if (this.bestPhase < 0 || this.syncFoundAt < 0) return false;

    const interleaverDepth = calculateInterleaverDepth(headerBytes);
    const sweepOffsets: number[] = [];
    for (let freqOff = -100; freqOff <= 100; freqOff += 10) {
      // Skip offsets close to what we've already tried
      if (Math.abs(freqOff - this.estimatedFreqOffset) < 8) continue;
      sweepOffsets.push(freqOff);
    }

    console.log(`[Decoder] Salvage: frequency sweep (${sweepOffsets.length} offsets, -100 to +100 Hz)...`);

    for (const freqOff of sweepOffsets) {
      // Try best phase first, then others
      const phasesToTry = [this.bestPhase];
      for (let p = 0; p < NUM_PHASES; p++) {
        if (p !== this.bestPhase) phasesToTry.push(p);
      }

      for (const phase of phasesToTry) {
        // Extract header symbols with this frequency offset
        const softResults = this.extractSymbolsWithOffset(
          phase, this.syncFoundAt, headerSymbols, freqOff
        );
        if (softResults.length < headerSymbols) continue;

        const softBits = softSymbolsToSoftBits(softResults, AUDIO.BITS_PER_SYMBOL)
          .slice(0, headerBytes * 8);
        const deinterleavedSoft = deinterleaveSoftBits(softBits, interleaverDepth, headerBytes);

        // Try soft FEC decode
        const softResult = decodeHeaderFECSoft(deinterleavedSoft);
        if (softResult.success) {
          const header = parseHeaderFrame(softResult.data);
          if (header && header.crcValid) {
            console.log(`[Decoder] Salvage: header recovered at freq offset ${freqOff} Hz, phase ${phase}`);
            this.headerInfo = header;
            this.headerRepeated = header.totalFrames > 1;
            this.frameCollector.setHeader(header);
            this.totalErrorsFixed += Math.max(0, softResult.correctedErrors);
            this.consecutiveHeaderFailures = 0;

            // Adopt this frequency offset for all future symbol extraction
            this.estimatedFreqOffset = freqOff;
            this.reextractWithOffset();

            if (phase !== this.bestPhase) {
              this.bestPhase = phase;
            }

            this.headerDecodedTime = Date.now();
            this.expectedEndTime = this.calculateExpectedEndTime(header.totalFrames);
            this.state = 'receiving_data';
            this.lastDebugInfo = `Header recovered (freq sweep ${freqOff >= 0 ? '+' : ''}${freqOff} Hz)`;
            return true;
          }
        }

        // Also try with redundancy combining (second header copy)
        const symbols2Start = this.syncFoundAt + headerSymbols;
        const softResults2 = this.extractSymbolsWithOffset(
          phase, symbols2Start, headerSymbols, freqOff
        );
        if (softResults2.length >= headerSymbols) {
          const softBits2 = softSymbolsToSoftBits(softResults2, AUDIO.BITS_PER_SYMBOL)
            .slice(0, headerBytes * 8);
          const deinterleavedSoft2 = deinterleaveSoftBits(softBits2, interleaverDepth, headerBytes);
          const redundantResult = decodeHeaderWithRedundancySoft(deinterleavedSoft, deinterleavedSoft2);
          if (redundantResult.success) {
            const header = parseHeaderFrame(redundantResult.data);
            if (header && header.crcValid) {
              console.log(`[Decoder] Salvage: header recovered (redundant) at freq offset ${freqOff} Hz`);
              this.headerInfo = header;
              this.headerRepeated = header.totalFrames > 1;
              this.frameCollector.setHeader(header);
              this.totalErrorsFixed += Math.max(0, redundantResult.correctedErrors);
              this.consecutiveHeaderFailures = 0;

              this.estimatedFreqOffset = freqOff;
              this.reextractWithOffset();

              if (phase !== this.bestPhase) {
                this.bestPhase = phase;
              }

              this.headerDecodedTime = Date.now();
              this.expectedEndTime = this.calculateExpectedEndTime(header.totalFrames);
              this.state = 'receiving_data';
              this.lastDebugInfo = `Header recovered (freq sweep ${freqOff >= 0 ? '+' : ''}${freqOff} Hz, redundant)`;
              return true;
            }
          }
        }
      }
    }

    console.log('[Decoder] Salvage: frequency sweep failed');
    return false;
  }

  /**
   * Brute-force header recovery in salvage mode.
   *
   * When FEC fails, we still have best-effort decoded bytes. Since we know:
   * - Bytes 0-1 MUST be [0x4E, 0x33] ("N3")
   * - Byte 2 high nibble MUST be 0x3 (version 3)
   * - Byte 2 low nibble is flags (0x00-0x07)
   * - Bytes 10-11 are CRC16 of bytes 0-9
   *
   * We fix the known bytes and try single-byte corrections on the remaining
   * 7 bytes (3-9), checking CRC16 for each candidate.
   */
  private bruteForceHeaderRecovery(headerBytes: number, headerSymbols: number): boolean {
    if (this.bestPhase < 0 || this.syncFoundAt < 0) return false;

    console.log('[Decoder] Salvage: brute-force header recovery...');

    const interleaverDepth = calculateInterleaverDepth(headerBytes);

    // Collect FEC-failed header candidates from all phases/offsets
    const candidates: Uint8Array[] = [];
    const offsets = [0, -1, 1, -2, 2];
    const phasesToTry = [this.bestPhase];
    for (let p = 0; p < NUM_PHASES; p++) {
      if (p !== this.bestPhase) phasesToTry.push(p);
    }

    for (const phase of phasesToTry) {
      for (const offset of offsets) {
        const headerStart = this.syncFoundAt + offset;
        if (headerStart < 0 || headerStart + headerSymbols > this.phaseSymbols[phase].length) continue;

        // Soft decode attempt - get best-effort bytes
        const softBits = this.extractSoftBitsForSlice(phase, headerStart, headerSymbols, headerBytes);
        if (softBits) {
          const deinterleavedSoft = deinterleaveSoftBits(softBits, interleaverDepth, headerBytes);
          const softResult = decodeHeaderFECSoft(deinterleavedSoft);
          if (softResult.data.length >= 12) {
            candidates.push(new Uint8Array(softResult.data));
          }
        }

        // Hard decode attempt
        const symbols = this.phaseSymbols[phase];
        const headerSymbolsArr = symbols.slice(headerStart, headerStart + headerSymbols);
        const bytesRaw = this.symbolsToBytes(headerSymbolsArr, headerBytes);
        const bytes = deinterleave(bytesRaw, interleaverDepth, headerBytes);
        const hardResult = decodeHeaderFEC(bytes);
        if (hardResult.data.length >= 12) {
          candidates.push(new Uint8Array(hardResult.data));
        }
      }
    }

    if (candidates.length === 0) return false;

    console.log(`[Decoder] Salvage: trying brute-force on ${candidates.length} header candidates`);

    // For each candidate, fix known bytes and try CRC
    for (const candidate of candidates) {
      // Fix known bytes
      candidate[0] = 0x4E; // 'N'
      candidate[1] = 0x33; // '3'

      // Try all valid flag combinations (8 options)
      for (let flags = 0; flags <= 0x07; flags++) {
        candidate[2] = 0x30 | flags; // version 3 + flags

        // Check CRC with known bytes fixed (no other corrections)
        const header = parseHeaderFrame(candidate);
        if (header && header.crcValid && this.isPlausibleHeader(header)) {
          console.log(`[Decoder] Salvage: header recovered via brute-force (flags=${flags})`);
          return this.acceptBruteForceHeader(header);
        }

        // Try single-byte corrections on bytes 3-7 (data fields, NOT session ID or CRC)
        // Bytes 8-9 (session ID) and 10-11 (CRC) are excluded because:
        // - Changing session ID easily creates false CRC matches
        // - CRC bytes are validated, not corrected
        for (let byteIdx = 3; byteIdx <= 7; byteIdx++) {
          const originalByte = candidate[byteIdx];
          for (let val = 0; val < 256; val++) {
            if (val === originalByte) continue;
            candidate[byteIdx] = val;
            const h = parseHeaderFrame(candidate);
            if (h && h.crcValid && this.isPlausibleHeader(h)) {
              console.log(`[Decoder] Salvage: header recovered via brute-force (fixed byte ${byteIdx}: ${originalByte}->${val})`);
              return this.acceptBruteForceHeader(h);
            }
          }
          candidate[byteIdx] = originalByte; // Restore
        }
      }
    }

    console.log('[Decoder] Salvage: brute-force failed');
    return false;
  }

  /**
   * Check if a recovered header has plausible values for the audio we have.
   */
  private isPlausibleHeader(header: HeaderInfo): boolean {
    // Basic range checks
    if (header.totalFrames < 1 || header.totalFrames > 100) return false;
    if (header.payloadLength < 1 || header.payloadLength > 50000) return false;
    if (header.originalLength < 1 || header.originalLength > 100000) return false;

    // Original size should be >= payload size (unless encrypted which adds overhead)
    if (!header.encrypted && header.originalLength < header.payloadLength) return false;

    // If compressed, original should typically be larger than payload
    // (but not always, so don't enforce strictly)

    // Check that frame count is consistent with payload size
    // Each frame carries ~FRAME_V3.PAYLOAD_SIZE bytes, so totalFrames should be
    // roughly payloadLength / frameSize (within 2x tolerance)
    const estimatedFrames = Math.ceil(header.payloadLength / FRAME_V3.PAYLOAD_SIZE);
    if (header.totalFrames > estimatedFrames * 2 + 1) return false;
    if (header.totalFrames < Math.ceil(estimatedFrames / 3)) return false;

    // Check against audio duration — we can estimate max possible data from audio length
    // Each symbol takes AUDIO.SYMBOL_DURATION_MS ms, and we have a finite number of symbols
    const symbolsAvailable = this.phaseSymbols[this.bestPhase >= 0 ? this.bestPhase : 0].length;
    const headerSymbolCount = this.calculateSymbolsForBytes(getHeaderSize()) * (header.totalFrames > 1 ? 2 : 1);
    const dataSymbolsAvailable = symbolsAvailable - (this.syncFoundAt >= 0 ? this.syncFoundAt : 0) - headerSymbolCount;
    if (dataSymbolsAvailable < 10) return false; // Not enough data symbols

    // Check that data frames actually fit in available audio
    // Each data frame needs: (3 + PAYLOAD_SIZE + RS_PARITY_SIZE) bytes worth of symbols
    const dataFrameBytes = getDataFrameSize(FRAME_V3.PAYLOAD_SIZE);
    const symbolsPerFrame = this.calculateSymbolsForBytes(dataFrameBytes);
    const totalDataSymbolsNeeded = header.totalFrames * symbolsPerFrame;
    if (totalDataSymbolsNeeded > dataSymbolsAvailable * 1.5) return false; // Allow 50% slack for timing drift

    return true;
  }

  private acceptBruteForceHeader(header: HeaderInfo): boolean {
    this.headerInfo = header;
    this.headerRepeated = header.totalFrames > 1;
    this.frameCollector.setHeader(header);
    this.consecutiveHeaderFailures = 0;
    this.headerDecodedTime = Date.now();
    this.expectedEndTime = this.calculateExpectedEndTime(header.totalFrames);
    this.state = 'receiving_data';
    this.lastDebugInfo = `Header recovered (brute-force)! Frames: ${header.totalFrames}, Size: ${header.originalLength}`;
    console.log('[Decoder] Header valid (brute-force)! Expecting', header.totalFrames, 'frames');
    return true;
  }

  /**
   * Extract symbols from raw audio at a specific frequency offset.
   * Used by salvage mode frequency sweep to try different offsets without
   * modifying the main symbol arrays.
   */
  private extractSymbolsWithOffset(
    phase: number, startIdx: number, count: number, freqOffset: number
  ): SoftDetectionResult[] {
    const results: SoftDetectionResult[] = [];
    const offset = phase * this.phaseOffset;
    const biases = this.toneBiases ?? undefined;

    const offsetGuard = this.getEffectiveGuardSamples();
    for (let i = 0; i < count; i++) {
      const symbolStart = offset + (startIdx + i) * this.symbolSamples;
      const analysisStart = symbolStart + offsetGuard;
      const analysisLength = this.symbolSamples - offsetGuard * 2;

      if (analysisStart + analysisLength > this.totalSamplesReceived) break;

      const samples = this.getBufferSamples(analysisStart, analysisLength);
      results.push(detectToneSoft(samples, this.sampleRate, freqOffset, biases));
    }

    return results;
  }

  /**
   * Pattern matching for specific mode
   */
  private matchesPatternForMode(symbols: number[], startIndex: number, pattern: number[], maxTone: number, salvage = false): boolean {
    let matches = 0;
    const tolerance = maxTone > 10 ? 2 : 1; // Larger tolerance for wideband (16 tones)

    for (let i = 0; i < pattern.length; i++) {
      if (symbols[startIndex + i] === pattern[i]) {
        matches++;
      } else if (Math.abs(symbols[startIndex + i] - pattern[i]) <= tolerance) {
        matches += 0.5; // Partial match for adjacent tones
      }
    }
    // Normal: allow 1 mismatch (94%). Salvage: allow ~25% mismatch (75%)
    const threshold = salvage ? pattern.length * 0.75 : pattern.length - 1;
    return matches >= threshold;
  }

  /**
   * Sync pattern matching for specific mode
   * Sync: [low, high, low, high, ...] alternating pattern
   * Made stricter to avoid false positives
   */
  private matchesSyncPatternForMode(symbols: number[], startIndex: number, maxTone: number, syncLen: number = 8, salvage = false): boolean {
    // Phone mode (4 tones): require exact 8/8 match - less margin for error
    // Wideband mode (16 tones): allow 7/8 - more tones means more potential drift
    // Salvage mode: allow 6/8 for phone, 5/8 for wideband
    const minMatch = salvage
      ? (maxTone > 10 ? syncLen - 3 : syncLen - 2)
      : (maxTone > 10 ? syncLen - 1 : syncLen);

    let matches = 0;
    for (let i = 0; i < Math.min(syncLen, symbols.length - startIndex); i++) {
      const sym = symbols[startIndex + i];
      const isEven = i % 2 === 0;

      // Even positions should be exactly 0, odd positions should be exactly maxTone
      // Allow small tolerance only for wideband (more tones = more potential drift)
      if (isEven) {
        if (sym === 0) matches++;
      } else {
        if (sym === maxTone || (maxTone > 10 && sym >= maxTone - 1)) matches++;
      }
    }

    return matches >= minMatch;
  }

  /**
   * Loose pattern matching for cross-device compatibility
   * Works for both phone (8 tones) and wideband (16 tones)
   * Phone mode is stricter since we have fewer tones
   */
  private matchesLoosePatternForMode(symbols: number[], startIndex: number, maxTone: number, salvage = false): boolean {
    const s = symbols.slice(startIndex, startIndex + 8);
    if (s.length < 8) return false;

    // Phone mode (maxTone=3): require exact calibration [0,1,2,3] and exact sync [0,3,0,3]
    // Wideband mode (maxTone=15): allow more tolerance
    const isPhoneMode = maxTone <= 7;

    if (isPhoneMode) {
      if (salvage) {
        // Salvage: count matches with ±1 tolerance, require 6/8
        let matches = 0;
        const expected = [0, 1, 2, 3, 0, maxTone, 0, maxTone];
        for (let i = 0; i < 8; i++) {
          if (s[i] === expected[i] || Math.abs(s[i] - expected[i]) <= 1) matches++;
        }
        return matches >= 6;
      }
      // Phone mode: exact calibration match required
      const calibOk = s[0] === 0 && s[1] === 1 && s[2] === 2 && s[3] === 3;
      // Phone mode: exact sync match required (alternating 0 and maxTone)
      const syncOk = s[4] === 0 && s[5] === maxTone &&
                     s[6] === 0 && s[7] === maxTone;
      return calibOk && syncOk;
    }

    // Wideband mode: allow tolerance
    const quarter = Math.floor(maxTone / 4);
    const threeQuarter = Math.floor((maxTone * 3) / 4);
    const tolerance = salvage ? 3 : 2;

    // Check calibration part (first 4 symbols should be: low, ~quarter, ~3/4, high)
    const calibOk = s[0] <= tolerance &&
                    s[1] >= quarter - tolerance && s[1] <= quarter + tolerance + 1 &&
                    s[2] >= threeQuarter - tolerance - 1 && s[2] <= threeQuarter + tolerance + 1 &&
                    s[3] >= maxTone - tolerance;

    // Check sync part (alternating low-high)
    const syncOk = s[4] <= tolerance && s[5] >= maxTone - tolerance &&
                   s[6] <= tolerance && s[7] >= maxTone - tolerance;

    return calibOk && syncOk;
  }

  /**
   * Calculate number of symbols needed for given bytes
   * Uses BITS_PER_SYMBOL from audio settings
   */
  private calculateSymbolsForBytes(byteCount: number): number {
    const bitsPerSymbol = AUDIO.BITS_PER_SYMBOL;
    return Math.ceil((byteCount * 8) / bitsPerSymbol);
  }

  /**
   * Calculate expected end time based on number of frames
   * Returns timestamp when transmission should be complete (with 50% buffer)
   */
  private calculateExpectedEndTime(totalFrames: number): number {
    // Symbol duration in ms (including guard)
    const symbolDurationMs = AUDIO.SYMBOL_DURATION_MS + AUDIO.GUARD_INTERVAL_MS;

    // Estimate symbols per frame (assuming max frame size for safety)
    const frameBytes = 3 + FRAME_V3.PAYLOAD_SIZE + FRAME_V3.RS_PARITY_SIZE; // ~147 bytes
    const symbolsPerFrame = this.calculateSymbolsForBytes(frameBytes);

    // Total data symbols
    const dataSymbols = totalFrames * symbolsPerFrame;

    // Add header symbols (with redundancy)
    const headerBytes = FRAME_V3.HEADER_SIZE + FRAME_V3.RS_PARITY_SIZE;
    const headerSymbols = this.calculateSymbolsForBytes(headerBytes) * 2; // Header sent twice

    // Total estimated duration in ms
    const totalSymbols = dataSymbols + headerSymbols;
    const estimatedDurationMs = totalSymbols * symbolDurationMs;

    // Add 50% buffer for timing variations
    const bufferMultiplier = 1.5;
    const expectedDurationMs = estimatedDurationMs * bufferMultiplier;

    console.log(`[Decoder] Expected duration: ${(expectedDurationMs / 1000).toFixed(1)}s for ${totalFrames} frames`);

    return Date.now() + expectedDurationMs;
  }

  // Track whether header was sent twice (for multi-frame messages)
  private headerRepeated = false;

  /**
   * Try to extract and decode header from a specific phase and offset
   * Returns decoded header info if successful, null otherwise
   */
  private tryHeaderAtOffset(
    phase: number,
    syncFoundAt: number,
    offset: number,
    headerBytes: number,
    headerSymbols: number
  ): { header: HeaderInfo; correctedErrors: number; redundant: boolean } | null {
    const symbols = this.phaseSymbols[phase];
    const headerStart = syncFoundAt + offset;

    if (headerStart < 0 || headerStart + headerSymbols > symbols.length) {
      return null;
    }

    const interleaverDepth = calculateInterleaverDepth(headerBytes);

    // === SOFT-DECISION PATH (try first for ~2-3 dB gain) ===
    const softBits = this.extractSoftBitsForSlice(phase, headerStart, headerSymbols, headerBytes);
    if (softBits) {
      const deinterleavedSoft = deinterleaveSoftBits(softBits, interleaverDepth, headerBytes);
      const softResult = decodeHeaderFECSoft(deinterleavedSoft);
      if (softResult.success) {
        const header = parseHeaderFrame(softResult.data);
        if (header && header.crcValid) {
          return { header, correctedErrors: softResult.correctedErrors, redundant: false };
        }
      }

      // Try soft redundant copy
      const symbols2Start = headerStart + headerSymbols;
      const softBits2 = this.extractSoftBitsForSlice(phase, symbols2Start, headerSymbols, headerBytes);
      if (softBits2) {
        const deinterleavedSoft2 = deinterleaveSoftBits(softBits2, interleaverDepth, headerBytes);
        const softRedundant = decodeHeaderWithRedundancySoft(deinterleavedSoft, deinterleavedSoft2);
        if (softRedundant.success) {
          const header = parseHeaderFrame(softRedundant.data);
          if (header && header.crcValid) {
            return { header, correctedErrors: softRedundant.correctedErrors, redundant: true };
          }
        }
      }
    }

    // === HARD-DECISION FALLBACK ===
    const headerSymbolsArr = symbols.slice(headerStart, headerStart + headerSymbols);
    const bytesRaw = this.symbolsToBytes(headerSymbolsArr, headerBytes);
    const bytes = deinterleave(bytesRaw, interleaverDepth, headerBytes);

    let decodeResult = decodeHeaderFEC(bytes);
    if (decodeResult.success) {
      const header = parseHeaderFrame(decodeResult.data);
      if (header && header.crcValid) {
        return { header, correctedErrors: decodeResult.correctedErrors, redundant: false };
      }
    }

    // Try hard redundant copy
    const symbols2Start = headerStart + headerSymbols;
    if (symbols2Start + headerSymbols <= symbols.length) {
      const symbols2Arr = symbols.slice(symbols2Start, symbols2Start + headerSymbols);
      const bytes2Raw = this.symbolsToBytes(symbols2Arr, headerBytes);
      const bytes2 = deinterleave(bytes2Raw, interleaverDepth, headerBytes);

      const decodeResult2 = decodeHeaderWithRedundancy(bytes, bytes2);
      if (decodeResult2.success) {
        const header = parseHeaderFrame(decodeResult2.data);
        if (header && header.crcValid) {
          return { header, correctedErrors: decodeResult2.correctedErrors, redundant: true };
        }
      }
    }

    return null;
  }

  /**
   * Try header decode by combining soft bits from multiple phases.
   * Different phases sample the symbol at different timing offsets within the symbol period,
   * providing partially independent measurements. Averaging improves SNR (~3-6 dB for 4 phases).
   */
  private tryHeaderMultiPhaseCombined(
    headerBytes: number,
    headerSymbols: number
  ): { header: HeaderInfo; correctedErrors: number } | null {
    const offsets = [0, -1, 1, -2, 2];
    const interleaverDepth = calculateInterleaverDepth(headerBytes);

    for (const offset of offsets) {
      const headerStart = this.syncFoundAt + offset;

      // Collect soft bits from all available phases
      const allPhaseSoftBits: number[][] = [];
      for (let p = 0; p < NUM_PHASES; p++) {
        const softBits = this.extractSoftBitsForSlice(p, headerStart, headerSymbols, headerBytes);
        if (softBits) {
          allPhaseSoftBits.push(softBits);
        }
      }

      if (allPhaseSoftBits.length < 2) continue;

      // Average soft bits across phases
      const combined: number[] = new Array(allPhaseSoftBits[0].length);
      for (let i = 0; i < combined.length; i++) {
        let sum = 0;
        for (const phaseBits of allPhaseSoftBits) {
          sum += phaseBits[i];
        }
        combined[i] = sum / allPhaseSoftBits.length;
      }

      const deinterleavedSoft = deinterleaveSoftBits(combined, interleaverDepth, headerBytes);
      const softResult = decodeHeaderFECSoft(deinterleavedSoft);
      if (softResult.success) {
        const header = parseHeaderFrame(softResult.data);
        if (header && header.crcValid) {
          console.log(`[Decoder] Header recovered via multi-phase combining (${allPhaseSoftBits.length} phases, offset=${offset})`);
          return { header, correctedErrors: softResult.correctedErrors };
        }
      }

      // Also try redundant copy combining
      const symbols2Start = headerStart + headerSymbols;
      const allPhase2SoftBits: number[][] = [];
      for (let p = 0; p < NUM_PHASES; p++) {
        const softBits2 = this.extractSoftBitsForSlice(p, symbols2Start, headerSymbols, headerBytes);
        if (softBits2) {
          allPhase2SoftBits.push(softBits2);
        }
      }

      if (allPhase2SoftBits.length >= 2) {
        const combined2: number[] = new Array(allPhase2SoftBits[0].length);
        for (let i = 0; i < combined2.length; i++) {
          let sum = 0;
          for (const phaseBits of allPhase2SoftBits) {
            sum += phaseBits[i];
          }
          combined2[i] = sum / allPhase2SoftBits.length;
        }

        const deinterleavedSoft2 = deinterleaveSoftBits(combined2, interleaverDepth, headerBytes);
        const redundantResult = decodeHeaderWithRedundancySoft(deinterleavedSoft, deinterleavedSoft2);
        if (redundantResult.success) {
          const header = parseHeaderFrame(redundantResult.data);
          if (header && header.crcValid) {
            console.log(`[Decoder] Header recovered via multi-phase combining + redundancy (offset=${offset})`);
            return { header, correctedErrors: redundantResult.correctedErrors };
          }
        }
      }
    }

    return null;
  }

  /**
   * Calculate average soft confidence for a range of symbols.
   * Used for diagnostic comparison of preamble vs header signal quality.
   */
  private averageSoftConfidence(phase: number, startIndex: number, count: number): number {
    const softResults = this.phaseSoftSymbols[phase];
    if (!softResults || startIndex < 0) return 0;

    const start = Math.max(0, startIndex);
    const end = Math.min(softResults.length, start + count);
    if (end <= start) return 0;

    let sum = 0;
    for (let i = start; i < end; i++) {
      sum += softResults[i].confidence;
    }
    return sum / (end - start);
  }

  private processHeader(): void {
    const symbols = this.phaseSymbols[this.bestPhase];

    // Get header size (12 + 16 = 28 bytes)
    const headerBytes = getHeaderSize();
    const headerSymbols = this.calculateSymbolsForBytes(headerBytes);

    const symbolsAfterSync = symbols.length - this.syncFoundAt;

    // Wait for enough symbols
    if (symbolsAfterSync < headerSymbols) {
      this.lastDebugInfo = `Header: ${symbolsAfterSync}/${headerSymbols} symbols`;
      return;
    }

    console.log('[Decoder] Got enough symbols for header...');

    // Estimate frequency offset from calibration tones (only on first attempt)
    if (this.consecutiveHeaderFailures === 0 && this.estimatedFreqOffset === 0) {
      this.estimateFreqOffsetFromCalibration();
    }

    // Try header extraction with offset retries
    // First try the detected position, then ±1, ±2 symbol offsets
    // In salvage mode, try wider range ±5
    const offsets = this.salvageMode
      ? [0, -1, 1, -2, 2, -3, 3, -4, 4, -5, 5]
      : [0, -1, 1, -2, 2];

    // Also try different phases if the primary phase fails
    const phasesToTry = [this.bestPhase];
    for (let p = 0; p < NUM_PHASES; p++) {
      if (p !== this.bestPhase && this.phaseSymbols[p].length >= this.syncFoundAt + headerSymbols) {
        phasesToTry.push(p);
      }
    }

    for (const phase of phasesToTry) {
      for (const offset of offsets) {
        const result = this.tryHeaderAtOffset(phase, this.syncFoundAt, offset, headerBytes, headerSymbols);
        if (result) {
          if (offset !== 0 || phase !== this.bestPhase) {
            console.log(`[Decoder] Header recovered with phase=${phase}, offset=${offset}`);
          }
          this.headerInfo = result.header;
          // headerRepeated should match encoder logic: only repeat for multi-frame messages
          // Do NOT use result.redundant - it reflects decoder recovery, not encoder behavior
          // For 1-frame messages, encoder sends only 1 header copy (see modulate.ts)
          this.headerRepeated = result.header.totalFrames > 1;
          this.frameCollector.setHeader(result.header);
          this.totalErrorsFixed += Math.max(0, result.correctedErrors);
          this.consecutiveHeaderFailures = 0;
          // Update best phase and sync position if different
          if (phase !== this.bestPhase) {
            this.bestPhase = phase;
          }
          if (offset !== 0) {
            this.syncFoundAt += offset;
          }
          // Set expected duration timeout
          this.headerDecodedTime = Date.now();
          this.expectedEndTime = this.calculateExpectedEndTime(result.header.totalFrames);
          this.state = 'receiving_data';
          this.lastDebugInfo = `Header OK${result.redundant ? ' (redundant)' : ''}! Frames: ${result.header.totalFrames}, Size: ${result.header.originalLength}`;
          console.log('[Decoder] Header valid! Expecting', result.header.totalFrames, 'frames');
          return;
        }
      }
    }

    // === MULTI-PHASE SOFT COMBINING ===
    // When individual phases fail, try averaging soft bits from all phases.
    // Different phases sample the symbol at different timing offsets,
    // providing partially independent measurements (~3-6 dB SNR gain).
    {
      const combineResult = this.tryHeaderMultiPhaseCombined(headerBytes, headerSymbols);
      if (combineResult) {
        this.headerInfo = combineResult.header;
        this.headerRepeated = combineResult.header.totalFrames > 1;
        this.frameCollector.setHeader(combineResult.header);
        this.totalErrorsFixed += Math.max(0, combineResult.correctedErrors);
        this.consecutiveHeaderFailures = 0;
        this.headerDecodedTime = Date.now();
        this.expectedEndTime = this.calculateExpectedEndTime(combineResult.header.totalFrames);
        this.state = 'receiving_data';
        this.lastDebugInfo = `Header OK (multi-phase)! Frames: ${combineResult.header.totalFrames}, Size: ${combineResult.header.originalLength}`;
        return;
      }
    }

    // Fallback: try direct FEC on best-phase symbols without offset retries
    const headerStart = this.syncFoundAt;
    const headerSymbolsArr = symbols.slice(headerStart, headerStart + headerSymbols);

    const bytesRaw = this.symbolsToBytes(headerSymbolsArr, headerBytes);
    const bytes = deinterleave(
      bytesRaw,
      calculateInterleaverDepth(headerBytes),
      headerBytes
    );

    // Try to decode header
    let decodeResult = decodeHeaderFEC(bytes);

    if (decodeResult.success) {
      const header = parseHeaderFrame(decodeResult.data);
      console.log('[Decoder] Parsed header:', header);

      if (header && header.crcValid) {
        // Check if this is a multi-frame message (header sent twice)
        this.headerRepeated = header.totalFrames > 1;

        if (this.headerRepeated && symbolsAfterSync >= headerSymbols * 2) {
          // Try second copy for better reliability
          const symbols2Start = headerStart + headerSymbols;
          const symbols2Arr = symbols.slice(symbols2Start, symbols2Start + headerSymbols);
          const bytes2Raw = this.symbolsToBytes(symbols2Arr, headerBytes);
          const bytes2 = deinterleave(
            bytes2Raw,
            calculateInterleaverDepth(headerBytes),
            headerBytes
          );

          const decodeResult2 = decodeHeaderWithRedundancy(bytes, bytes2);

          if (decodeResult2.success) {
            const header2 = parseHeaderFrame(decodeResult2.data);
            if (header2 && header2.crcValid) {
              console.log('[Decoder] Used redundant header copy');
              decodeResult = decodeResult2;
            }
          }
        }

        this.headerInfo = header;
        this.frameCollector.setHeader(header);
        this.totalErrorsFixed += Math.max(0, decodeResult.correctedErrors);
        this.consecutiveHeaderFailures = 0;  // Reset failure counter on success

        // Set expected duration timeout
        this.headerDecodedTime = Date.now();
        this.expectedEndTime = this.calculateExpectedEndTime(header.totalFrames);

        this.state = 'receiving_data';
        this.lastDebugInfo = `Header OK! Frames: ${header.totalFrames}, Size: ${header.originalLength}`;
        console.log('[Decoder] Header valid! Expecting', header.totalFrames, 'frames');
        return;
      } else {
        const reason = header ? 'CRC invalid' : 'Parse failed';
        console.log('[Decoder] Header invalid:', reason);
      }
    } else {
      // If we have enough for second copy, try with redundancy
      if (symbolsAfterSync >= headerSymbols * 2) {
        const symbols2Start = headerStart + headerSymbols;
        const symbols2Arr = symbols.slice(symbols2Start, symbols2Start + headerSymbols);
        const bytes2Raw = this.symbolsToBytes(symbols2Arr, headerBytes);
        const bytes2 = deinterleave(
          bytes2Raw,
          calculateInterleaverDepth(headerBytes),
          headerBytes
        );

        const decodeResult2 = decodeHeaderWithRedundancy(bytes, bytes2);

        if (decodeResult2.success) {
          const header = parseHeaderFrame(decodeResult2.data);
          if (header && header.crcValid) {
            this.headerInfo = header;
            // headerRepeated should match encoder logic, not decoder recovery method
            // Encoder only sends 2 copies for multi-frame messages (totalFrames > 1)
            this.headerRepeated = header.totalFrames > 1;
            this.frameCollector.setHeader(header);
            this.totalErrorsFixed += Math.max(0, decodeResult2.correctedErrors);

            // Set expected duration timeout
            this.headerDecodedTime = Date.now();
            this.expectedEndTime = this.calculateExpectedEndTime(header.totalFrames);

            this.state = 'receiving_data';
            this.lastDebugInfo = `Header OK (redundant)! Frames: ${header.totalFrames}`;
            console.log('[Decoder] Header valid from redundant copy!');
            return;
          }
        }
      }
    }

    // Diagnostic: show Viterbi best-effort decoded bytes and signal quality comparison
    const softBitsForDiag = this.extractSoftBitsForSlice(this.bestPhase, this.syncFoundAt, headerSymbols, headerBytes);
    let diagBytesStr = '?';
    if (softBitsForDiag) {
      const deintSoft = deinterleaveSoftBits(softBitsForDiag, calculateInterleaverDepth(headerBytes), headerBytes);
      const diagResult = decodeHeaderFECSoft(deintSoft);
      if (diagResult.data.length > 0) {
        diagBytesStr = `[${Array.from(diagResult.data.slice(0, 4))}]`;
      } else {
        // Fallback to raw coded bytes
        const headerSymbolsArr2 = symbols.slice(headerStart, headerStart + headerSymbols);
        const bytesForLog = deinterleave(
          this.symbolsToBytes(headerSymbolsArr2, headerBytes),
          calculateInterleaverDepth(headerBytes),
          headerBytes
        );
        diagBytesStr = `[${Array.from(bytesForLog.slice(0, 4))}] (coded)`;
      }

    }
    const preambleConf = this.averageSoftConfidence(this.bestPhase, this.syncFoundAt - 16, 16);
    const headerConf = this.averageSoftConfidence(this.bestPhase, this.syncFoundAt, Math.min(headerSymbols, 50));
    console.log(`[Decoder] Header decode failed (${offsets.length * phasesToTry.length} combinations tried). Bytes[0..3]: ${diagBytesStr} (expected [78, 51, ...])`);
    console.log(`[Decoder] Signal quality: preamble ${(preambleConf * 100).toFixed(0)}% → header ${(headerConf * 100).toFixed(0)}% confidence`);

    // Detect v2 protocol: v3 interleaved header always starts with 0xDB,
    // v2 (RS-only, no convolutional) starts with 0x4E ('N' magic byte)
    if (headerConf > 0.6) {
      const rawHeaderSymbols = symbols.slice(headerStart, headerStart + headerSymbols);
      const rawInterleavedBytes = this.symbolsToBytes(rawHeaderSymbols, headerBytes);
      if (rawInterleavedBytes[0] === 0x4E) {
        this.suspectV2Protocol = true;
        console.log('[Decoder] Warning: raw data starts with 0x4E (v2 protocol signature). Sender may be running outdated code.');
        // Set error message on progress so CLI timeout path can use it
        this.progress.value = {
          ...this.progress.value,
          errorMessage: 'could not decode header. The sender appears to be running an outdated version (v2 protocol). Ask them to reload/clear their browser cache and resend.',
        };
      }
    }

    // Salvage mode: frequency sweep and brute-force attempts
    if (this.salvageMode) {
      const sweepResult = this.frequencySweepHeaderDecode(headerBytes, headerSymbols);
      if (sweepResult) {
        return; // Success via frequency sweep
      }

      const bruteResult = this.bruteForceHeaderRecovery(headerBytes, headerSymbols);
      if (bruteResult) {
        return; // Success via brute-force
      }
    }

    // Try spectral interference compensation on first overall failure
    if (!this.toneBiases) {
      const biasDetected = this.estimateToneBiases();
      if (biasDetected) {
        console.log('[Decoder] Retrying header with interference compensation at same sync position...');

        // Re-extract header symbols at current sync position WITH biases applied
        const headerSymbols2 = this.calculateSymbolsForBytes(headerBytes);
        const interleaverDepth2 = calculateInterleaverDepth(headerBytes);

        // Try with biases at current position + frequency offsets
        const biasOffsets = [this.estimatedFreqOffset, 0];
        for (let off = -100; off <= 100; off += 10) {
          if (!biasOffsets.includes(off)) biasOffsets.push(off);
        }

        for (const freqOff of biasOffsets) {
          const softResults = this.extractSymbolsWithOffset(
            this.bestPhase, this.syncFoundAt, headerSymbols2, freqOff
          );
          if (softResults.length < headerSymbols2) continue;

          const softBits = softSymbolsToSoftBits(softResults, AUDIO.BITS_PER_SYMBOL)
            .slice(0, headerBytes * 8);
          const deinterleavedSoft = deinterleaveSoftBits(softBits, interleaverDepth2, headerBytes);

          // Try soft FEC decode
          const softResult = decodeHeaderFECSoft(deinterleavedSoft);
          if (softResult.success) {
            const header = parseHeaderFrame(softResult.data);
            if (header && header.crcValid && this.isPlausibleHeader(header)) {
              console.log(`[Decoder] Header recovered with bias compensation at freq ${freqOff} Hz!`);
              this.headerInfo = header;
              this.headerRepeated = header.totalFrames > 1;
              this.frameCollector.setHeader(header);
              this.totalErrorsFixed += Math.max(0, softResult.correctedErrors);
              this.consecutiveHeaderFailures = 0;
              this.estimatedFreqOffset = freqOff;
              this.reextractWithOffset();
              this.headerDecodedTime = Date.now();
              this.expectedEndTime = this.calculateExpectedEndTime(header.totalFrames);
              this.state = 'receiving_data';
              this.lastDebugInfo = `Header recovered (bias + freq ${freqOff >= 0 ? '+' : ''}${freqOff} Hz)`;
              return;
            }
          }

          // Also try redundancy combining with biases
          const symbols2Start = this.syncFoundAt + headerSymbols2;
          const softResults2 = this.extractSymbolsWithOffset(
            this.bestPhase, symbols2Start, headerSymbols2, freqOff
          );
          if (softResults2.length >= headerSymbols2) {
            const softBits2 = softSymbolsToSoftBits(softResults2, AUDIO.BITS_PER_SYMBOL)
              .slice(0, headerBytes * 8);
            const deinterleavedSoft2 = deinterleaveSoftBits(softBits2, interleaverDepth2, headerBytes);
            const redundantResult = decodeHeaderWithRedundancySoft(deinterleavedSoft, deinterleavedSoft2);
            if (redundantResult.success) {
              const header = parseHeaderFrame(redundantResult.data);
              if (header && header.crcValid && this.isPlausibleHeader(header)) {
                console.log(`[Decoder] Header recovered with bias + redundancy at freq ${freqOff} Hz!`);
                this.headerInfo = header;
                this.headerRepeated = header.totalFrames > 1;
                this.frameCollector.setHeader(header);
                this.totalErrorsFixed += Math.max(0, redundantResult.correctedErrors);
                this.consecutiveHeaderFailures = 0;
                this.estimatedFreqOffset = freqOff;
                this.reextractWithOffset();
                this.headerDecodedTime = Date.now();
                this.expectedEndTime = this.calculateExpectedEndTime(header.totalFrames);
                this.state = 'receiving_data';
                this.lastDebugInfo = `Header recovered (bias + redundancy, freq ${freqOff >= 0 ? '+' : ''}${freqOff} Hz)`;
                return;
              }
            }
          }
        }

        // Bias sweep didn't find header — also try brute-force with biases
        console.log('[Decoder] Bias compensation frequency sweep failed, trying brute-force with biases...');
        if (this.bruteForceHeaderRecovery(headerBytes, this.calculateSymbolsForBytes(headerBytes))) {
          return;
        }

        // Bias-compensated decode at this position failed.
        // Don't restart with biases — fall through to normal failure path which
        // marks this position as failed and tries the next best without bias changes.
        // This avoids changing symbol extraction which could hurt soft-decision FEC.
        console.log('[Decoder] Bias compensation at this position failed, trying next position...');
      }
    }

    // Header decode failed - reset and try again
    this.consecutiveHeaderFailures++;

    // Fatal failure - too many header decode failures
    if (this.consecutiveHeaderFailures >= Decoder.FATAL_HEADER_FAILURES) {
      // If we haven't tried the other mode yet, try switching
      if (!this.modeRetryAttempted && this.detectedAudioMode) {
        const currentMode = this.detectedAudioMode;
        const otherMode: AudioMode = currentMode === 'phone' ? 'wideband' : 'phone';
        console.log(`[Decoder] Fatal header failures in ${currentMode} mode, trying ${otherMode} mode`);

        this.modeRetryAttempted = true;
        this.consecutiveHeaderFailures = 0;

        // Switch to other mode
        setAudioMode(otherMode);
        this.detectedAudioMode = otherMode;
        this.symbolExtractionMode = null; // Force re-extraction

        // Reset symbol buffers and detection state
        this.bestPhase = -1;
        this.syncFoundAt = -1;
        for (let p = 0; p < NUM_PHASES; p++) {
          this.phaseSymbols[p] = [];
        }

        // Re-initialize chirp detector for new mode
        this.chirpDetector = new ChirpDetector(this.sampleRate, 0.3);
        this.chirpDetected = false;
        this.chirpEndSample = -1;
        this.state = 'detecting_preamble';
        this.lastDebugInfo = `Trying ${otherMode} mode...`;
        this.updateProgress();
        return;
      }

      // Already tried both modes or no mode detected - give up
      let errorMsg: string;
      if (this.suspectV2Protocol) {
        errorMsg = 'could not decode header. The sender appears to be running an outdated version. Ask them to reload/clear cache and resend.';
      } else if (this.modeRetryAttempted) {
        errorMsg = 'could not decode header. Signal may be too distorted. Try: nedagram analyze <file>';
      } else {
        errorMsg = 'could not decode header. Signal may be too distorted. Try: nedagram analyze <file>';
      }

      console.error('[Decoder] Fatal: Too many header failures, giving up');
      this.state = 'error';
      this.lastDebugInfo = errorMsg;
      this.updateProgress();

      if (this.onError) {
        this.onError(new Error(errorMsg));
      }
      return;
    }

    if (this.consecutiveHeaderFailures >= Decoder.MAX_HEADER_FAILURES) {
      this.lastDebugInfo = 'Poor signal - try moving closer or reducing noise';
    } else {
      this.lastDebugInfo = 'Header decode failed, retrying...';
    }

    // Mark this sync position as failed to avoid retrying the same position
    if (this.bestPhase >= 0 && this.syncFoundAt >= 0) {
      this.markSyncPositionFailed(this.bestPhase, this.syncFoundAt);
    }

    this.bestPhase = -1;
    this.syncFoundAt = -1;

    // Trim old symbols to save memory
    for (let p = 0; p < NUM_PHASES; p++) {
      if (this.phaseSymbols[p].length > 300) {
        this.phaseSymbols[p] = this.phaseSymbols[p].slice(-200);
      }
    }
  }

  private framesAttempted: Set<number> = new Set();

  /**
   * Get optimal frame size matching encoder's getOptimalFrameSize logic
   */
  private getOptimalFrameSize(): number {
    if (!this.headerInfo) return FRAME_V3.PAYLOAD_SIZE;

    const totalPayload = this.headerInfo.payloadLength;

    // Match encoder's optimal frame size logic
    if (totalPayload <= 32) return 32;
    if (totalPayload <= 64) return 64;
    return FRAME_V3.PAYLOAD_SIZE; // 128
  }

  /**
   * Calculate actual payload size for a specific frame (0-indexed)
   * Matches encoder's packetize logic exactly
   */
  private getActualFramePayloadSize(frameIndex: number): number {
    if (!this.headerInfo) return FRAME_V3.PAYLOAD_SIZE;

    const frameSize = this.getOptimalFrameSize();
    const totalPayload = this.headerInfo.payloadLength;

    const start = frameIndex * frameSize;
    const end = Math.min(start + frameSize, totalPayload);
    return Math.max(0, end - start);
  }

  private processDataFrame(): void {
    if (!this.headerInfo) return;

    const symbols = this.phaseSymbols[this.bestPhase];

    // Calculate where data frames start
    const headerEncodedBytes = getHeaderSize();
    const headerCopies = this.headerRepeated ? 2 : 1;
    const headerSymbols = this.calculateSymbolsForBytes(headerEncodedBytes) * headerCopies;
    const dataStart = this.syncFoundAt + headerSymbols;

    const framesExpected = this.headerInfo.totalFrames;
    const symbolsAvailable = symbols.length - dataStart;

    // Log progress periodically for long transmissions
    const framesReceived = this.frameCollector.getReceivedCount();
    if (framesReceived > 0 && framesReceived % 5 === 0) {
      const bufferUsage = ((this.totalSamplesReceived % this.sampleBuffer.length) / this.sampleBuffer.length * 100).toFixed(0);
      console.log(`[Decoder] Progress: ${framesReceived}/${framesExpected} frames, ${symbols.length} symbols, buffer: ${bufferUsage}%`);
    }

    // Calculate symbol offset for each frame
    const frameSymbolOffsets: number[] = [0];
    for (let i = 0; i < framesExpected; i++) {
      const payloadSize = this.getActualFramePayloadSize(i);
      const frameBytes = getDataFrameSize(payloadSize);
      const frameSym = this.calculateSymbolsForBytes(frameBytes);
      frameSymbolOffsets.push(frameSymbolOffsets[i] + frameSym);
    }

    // Calculate how many complete frames we have
    let framesAvailable = 0;
    for (let i = 0; i < framesExpected; i++) {
      if (frameSymbolOffsets[i + 1] <= symbolsAvailable) {
        framesAvailable = i + 1;
      }
    }

    const optimalFrameSize = this.getOptimalFrameSize();
    this.lastDebugInfo = `Data: ${framesAvailable}/${framesExpected} frames (${this.headerInfo.payloadLength}B total)`;

    // Symbol offsets to try for data frames (timing jitter compensation)
    const dataOffsets = [0, -1, 1, -2, 2, -3, 3];

    // Process any complete frames we haven't attempted yet
    for (let f = 0; f < framesAvailable && f < framesExpected; f++) {
      // Skip frames we've already attempted
      if (this.framesAttempted.has(f)) continue;

      // Calculate this frame's actual payload size
      const thisFramePayloadSize = this.getActualFramePayloadSize(f);
      if (thisFramePayloadSize <= 0) {
        this.framesAttempted.add(f);
        continue;
      }
      const thisFrameEncodedBytes = getDataFrameSize(thisFramePayloadSize);
      const frameSymCount = frameSymbolOffsets[f + 1] - frameSymbolOffsets[f];

      // Frame position from pre-calculated offsets
      const baseFrameStart = dataStart + frameSymbolOffsets[f];

      // Try different offsets and phases
      let decoded = false;

      const interleaverDepth = calculateInterleaverDepth(thisFrameEncodedBytes);

      // First try the current phase with different offsets (soft then hard)
      for (const offset of dataOffsets) {
        if (decoded) break;

        const frameStart = baseFrameStart + offset;
        const frameEnd = frameStart + frameSymCount;

        if (frameStart < 0 || frameEnd > symbols.length) continue;

        if (offset === 0) {
          console.log('[Decoder] Processing data frame', f, 'size:', thisFrameEncodedBytes, 'bytes');
        }

        // === SOFT-DECISION PATH (try first) ===
        const softBits = this.extractSoftBitsForSlice(this.bestPhase, frameStart, frameSymCount, thisFrameEncodedBytes);
        if (softBits) {
          const deinterleavedSoft = deinterleaveSoftBits(softBits, interleaverDepth, thisFrameEncodedBytes);
          const softDecodeResult = decodeDataFECSoft(deinterleavedSoft, thisFramePayloadSize);
          if (softDecodeResult.success) {
            const frame = parseDataFrame(softDecodeResult.data);
            if (frame && frame.crcValid) {
              this.frameCollector.addFrame(frame.frameIndex, frame.payload, this.headerInfo.sessionId);
              this.totalErrorsFixed += Math.max(0, softDecodeResult.correctedErrors);
              this.failedDataFrames.delete(f);
              decoded = true;
              if (offset !== 0) console.log('[Decoder] Frame', f, 'soft-recovered with offset', offset);
              console.log('[Decoder] Frame', frame.frameIndex, 'OK (soft), payload:', frame.payloadLength, 'bytes');
              this.lastDebugInfo = `Frame ${frame.frameIndex}/${framesExpected} received`;
              if (this.frameCollector.isComplete()) { this.finalizeDecoding(); return; }
              break;
            }
          }
        }

        // === HARD-DECISION FALLBACK ===
        const frameSymbolsArr = symbols.slice(frameStart, frameEnd);
        const frameBytesRaw = this.symbolsToBytes(frameSymbolsArr, thisFrameEncodedBytes);
        const frameBytes = deinterleave(frameBytesRaw, interleaverDepth, thisFrameEncodedBytes);

        if (offset === 0) {
          console.log('[Decoder] Hard fallback - first 10 bytes:', Array.from(frameBytes.slice(0, 10)));
          console.log('[Decoder] Expected: [68, ...] = "D" magic');
        }

        const decodeResult = decodeDataFEC(frameBytes, thisFramePayloadSize);

        if (decodeResult.success) {
          const frame = parseDataFrame(decodeResult.data);

          if (frame && frame.crcValid) {
            this.frameCollector.addFrame(frame.frameIndex, frame.payload, this.headerInfo.sessionId);
            this.totalErrorsFixed += Math.max(0, decodeResult.correctedErrors);
            this.failedDataFrames.delete(f);
            decoded = true;

            if (offset !== 0) console.log('[Decoder] Frame', f, 'hard-recovered with offset', offset);
            console.log('[Decoder] Frame', frame.frameIndex, 'OK (hard), payload:', frame.payloadLength, 'bytes');
            this.lastDebugInfo = `Frame ${frame.frameIndex}/${framesExpected} received`;

            if (this.frameCollector.isComplete()) {
              this.finalizeDecoding();
              return;
            }
            break;
          }
        }
      }

      // If still not decoded, try other phases with offsets (soft first, then hard)
      if (!decoded) {
        for (let phase = 0; phase < NUM_PHASES && !decoded; phase++) {
          if (phase === this.bestPhase) continue;
          const phaseSymbols = this.phaseSymbols[phase];
          if (phaseSymbols.length < baseFrameStart + frameSymCount) continue;

          for (const offset of dataOffsets) {
            if (decoded) break;

            const frameStart = baseFrameStart + offset;
            const frameEnd = frameStart + frameSymCount;

            if (frameStart < 0 || frameEnd > phaseSymbols.length) continue;

            // === SOFT-DECISION FIRST (other phase) ===
            const softBits = this.extractSoftBitsForSlice(phase, frameStart, frameSymCount, thisFrameEncodedBytes);
            if (softBits) {
              const intDepth = calculateInterleaverDepth(thisFrameEncodedBytes);
              const deinterleavedSoft = deinterleaveSoftBits(softBits, intDepth, thisFrameEncodedBytes);
              const softResult = decodeDataFECSoft(deinterleavedSoft, thisFramePayloadSize);

              if (softResult.success) {
                const frame = parseDataFrame(softResult.data);
                if (frame && frame.crcValid) {
                  this.frameCollector.addFrame(frame.frameIndex, frame.payload, this.headerInfo!.sessionId);
                  this.totalErrorsFixed += Math.max(0, softResult.correctedErrors);
                  this.failedDataFrames.delete(f);
                  decoded = true;

                  console.log('[Decoder] Frame', f, 'soft-recovered with phase', phase, 'offset', offset);
                  console.log('[Decoder] Frame', frame.frameIndex, 'OK (soft), payload:', frame.payloadLength, 'bytes');
                  this.lastDebugInfo = `Frame ${frame.frameIndex}/${framesExpected} received`;

                  if (this.frameCollector.isComplete()) { this.finalizeDecoding(); return; }
                  break;
                }
              }
            }

            // === HARD-DECISION FALLBACK (other phase) ===
            const frameSymbolsArr = phaseSymbols.slice(frameStart, frameEnd);
            const frameBytesRaw = this.symbolsToBytes(frameSymbolsArr, thisFrameEncodedBytes);
            const frameBytes = deinterleave(
              frameBytesRaw,
              calculateInterleaverDepth(thisFrameEncodedBytes),
              thisFrameEncodedBytes
            );

            const decodeResult = decodeDataFEC(frameBytes, thisFramePayloadSize);

            if (decodeResult.success) {
              const frame = parseDataFrame(decodeResult.data);

              if (frame && frame.crcValid) {
                this.frameCollector.addFrame(frame.frameIndex, frame.payload, this.headerInfo!.sessionId);
                this.totalErrorsFixed += Math.max(0, decodeResult.correctedErrors);
                this.failedDataFrames.delete(f);
                decoded = true;

                console.log('[Decoder] Frame', f, 'hard-recovered with phase', phase, 'offset', offset);
                console.log('[Decoder] Frame', frame.frameIndex, 'OK (hard), payload:', frame.payloadLength, 'bytes');
                this.lastDebugInfo = `Frame ${frame.frameIndex}/${framesExpected} received`;

                if (this.frameCollector.isComplete()) {
                  this.finalizeDecoding();
                  return;
                }
                break;
              }
            }
          }
        }
      }

      this.framesAttempted.add(f);

      if (!decoded) {
        console.log('[Decoder] Frame', f, 'FEC failed after trying', dataOffsets.length * NUM_PHASES, 'combinations');
        this.failedDataFrames.add(f);
        this.lastDebugInfo = `Frame ${f} FEC failed - signal issues`;
      }
    }

    // Check for timeout: if we have significantly more symbols than expected but still can't decode
    const totalExpectedSymbols = frameSymbolOffsets[framesExpected];
    const bufferRatio = this.salvageMode ? Decoder.SYMBOL_BUFFER_RATIO * 2 : Decoder.SYMBOL_BUFFER_RATIO;
    const symbolsWithBuffer = Math.floor(totalExpectedSymbols * bufferRatio);

    if (symbolsAvailable >= symbolsWithBuffer) {
      // We have enough symbols (with buffer) - check if all frames have been attempted and failed
      const allFramesAttempted = this.framesAttempted.size >= framesExpected;
      const successfulFrames = this.frameCollector.getReceivedCount();
      const failedFrames = this.failedDataFrames.size;

      if (allFramesAttempted && successfulFrames === 0 && failedFrames > 0) {
        // All frames attempted, none successful - fail
        console.error('[Decoder] All data frame decodes failed. Expected:', totalExpectedSymbols, 'symbols, received:', symbolsAvailable);
        this.state = 'error';
        this.lastDebugInfo = 'Data decode failed - signal too weak or corrupted. Try moving closer.';
        this.updateProgress();

        if (this.onError) {
          this.onError(new Error('Failed to decode data frames. The signal may be too weak or corrupted.'));
        }
        return;
      }

      // Some frames successful but not complete - partial decode
      if (allFramesAttempted && successfulFrames > 0 && successfulFrames < framesExpected) {
        console.warn('[Decoder] Partial decode:', successfulFrames, '/', framesExpected, 'frames');
        // Continue waiting a bit more, but update status
        this.lastDebugInfo = `Partial: ${successfulFrames}/${framesExpected} frames - signal issues`;
      }
    }
  }

  /**
   * Convert symbols back to bytes
   * Uses BITS_PER_SYMBOL from audio settings
   */
  private symbolsToBytes(symbols: number[], expectedBytes: number): Uint8Array {
    const bitsPerSymbol = AUDIO.BITS_PER_SYMBOL;
    const symbolMask = (1 << bitsPerSymbol) - 1;

    // Special case: 4 bits per symbol = exactly 2 symbols per byte
    if (bitsPerSymbol === 4) {
      const bytes = new Uint8Array(expectedBytes);
      for (let i = 0; i < expectedBytes; i++) {
        const high = symbols[i * 2] & 0x0F;
        const low = symbols[i * 2 + 1] & 0x0F;
        bytes[i] = (high << 4) | low;
      }
      return bytes;
    }

    // General case: bit unpacking for 2 or 3 bits per symbol
    const bytes = new Uint8Array(expectedBytes);
    let bitBuffer = 0;
    let bitsInBuffer = 0;
    let byteIndex = 0;

    for (const symbol of symbols) {
      bitBuffer = (bitBuffer << bitsPerSymbol) | (symbol & symbolMask);
      bitsInBuffer += bitsPerSymbol;

      while (bitsInBuffer >= 8 && byteIndex < expectedBytes) {
        bitsInBuffer -= 8;
        bytes[byteIndex++] = (bitBuffer >> bitsInBuffer) & 0xFF;
      }

      if (byteIndex >= expectedBytes) break;
    }

    return bytes;
  }

  private async finalizeDecoding(): Promise<void> {
    if (!this.headerInfo) return;

    try {
      // Reassemble payload (or use pending payload if retrying decryption)
      let payload = this.pendingPayload;
      if (!payload) {
        payload = this.frameCollector.reassemble();
        if (!payload) {
          throw new Error('Failed to reassemble payload');
        }
      }

      // Store payload in case we need to retry with different password
      this.pendingPayload = payload;

      // Process payload: verify CRC32, decrypt (if needed), then decompress
      const result = await processPayload(
        payload,
        this.headerInfo.encrypted,
        this.headerInfo.compressed,
        this.headerInfo.compressionAlgo,
        this.headerInfo.originalLength,
        this.headerInfo.hasCrc32,
        this.password || undefined
      );

      // Check if password is needed
      if (result.needsPassword) {
        console.log('[Decoder] Encrypted data - password required');
        this.state = 'complete';
        this.updateProgress();

        this.onComplete?.({
          data: new Uint8Array(0),
          text: '',
          checksum: '',
          encrypted: true,
          needsPassword: true,
          stats: {
            originalSize: this.headerInfo.originalLength,
            compressedSize: this.headerInfo.payloadLength,
            compressed: this.headerInfo.compressed,
            frameCount: this.headerInfo.totalFrames,
            errorsFixed: this.totalErrorsFixed,
          },
        });
        return;
      }

      // Check for decryption/decompression errors
      if (!result.success || !result.data) {
        throw new Error(result.error || 'Failed to process payload');
      }

      const data = result.data;

      // Calculate checksum
      const checksum = await sha256Hex(data);

      // Convert to text
      const text = bytesToString(data);

      this.state = 'complete';
      this.pendingPayload = null;  // Clear pending payload on success
      this.updateProgress();

      // Use console.error for CLI compatibility (avoids stdout pollution)

      this.onComplete?.({
        data,
        text,
        checksum,
        encrypted: this.headerInfo.encrypted,
        stats: {
          originalSize: this.headerInfo.originalLength,
          compressedSize: this.headerInfo.payloadLength,
          compressed: this.headerInfo.compressed,
          frameCount: this.headerInfo.totalFrames,
          errorsFixed: this.totalErrorsFixed,
        },
      });
    } catch (err) {
      console.error('[Decoder] Finalize error:', err);
      this.handleError(err instanceof Error ? err : new Error('Decoding failed'));
    }
  }

  /**
   * Soft reset - restart detection without stopping recording
   * Use for recoverable errors
   */
  softReset(): void {
    console.log('[Decoder] Soft reset - restarting detection');
    this.frameCollector.reset();
    this.headerInfo = null;
    this.bestPhase = -1;
    this.syncFoundAt = -1;
    this.framesAttempted = new Set();
    this.failedDataFrames.clear();
    this.headerRepeated = false;
    this.detectedAudioMode = null;
    this.chirpDetected = false;
    this.chirpEndSample = -1;
    this.chirpDetector.reset();
    // Reset timeout tracking
    this.syncDetectedTime = 0;
    this.headerDecodedTime = 0;
    this.expectedEndTime = 0;
    // Keep lastHighEnergyTime - we still want to track silence
    this.state = 'detecting_preamble';
    this.lastDebugInfo = 'Restarting detection... Play audio again';
    this.updateProgress();
  }

  private handleError(error: Error): void {
    // For certain errors, try soft reset instead of failing
    if (this.canRecover(error)) {
      console.log('[Decoder] Recoverable error, soft resetting:', error.message);
      this.lastDebugInfo = `Error: ${error.message}. Retrying...`;
      this.softReset();
      return;
    }

    this.state = 'error';
    this.progress.value = {
      ...this.progress.value,
      state: 'error',
      errorMessage: error.message,
    };
    this.onError?.(error);
  }

  /**
   * Handle timeout errors (silence or duration exceeded)
   * These are non-recoverable - stop listening and show error
   */
  private handleTimeoutError(message: string): void {
    console.log('[Decoder] Timeout:', message);
    this.state = 'error';
    this.lastDebugInfo = message;
    this.progress.value = {
      ...this.progress.value,
      state: 'error',
      errorMessage: message,
    };
    this.onError?.(new Error(message));
  }

  /**
   * Check if error is recoverable (can retry)
   */
  private canRecover(error: Error): boolean {
    const recoverableErrors = [
      'Failed to reassemble payload',
      'Decompression failed',
      'Invalid header',
    ];
    // Don't auto-recover from decryption failures - let the user retry with correct password
    const nonRecoverableErrors = [
      'Decryption failed',
      'wrong password',
    ];
    if (nonRecoverableErrors.some(msg => error.message.toLowerCase().includes(msg.toLowerCase()))) {
      return false;
    }
    return recoverableErrors.some(msg => error.message.includes(msg));
  }

  private updateProgress(): void {
    const totalSymbols = this.bestPhase >= 0
      ? this.phaseSymbols[this.bestPhase].length
      : Math.max(...this.phaseSymbols.map(p => p.length));

    this.progress.value = {
      state: this.state,
      signalLevel: this.progress.value.signalLevel,
      syncConfidence: this.bestPhase >= 0 ? 100 : 0,
      framesReceived: this.frameCollector.getReceivedCount(),
      totalFrames: this.frameCollector.getTotalFrames(),
      errorsFixed: this.totalErrorsFixed,
      errorMessage: this.progress.value.errorMessage,
      debugInfo: this.lastDebugInfo,
      symbolsReceived: totalSymbols,
      chirpDetected: this.chirpDetected,
      signalWarning: this.consecutiveHeaderFailures >= Decoder.MAX_HEADER_FAILURES,
    };
  }

  /**
   * Detect chirp (frequency sweep) in the audio
   * Chirp goes from low to high frequency, indicating preamble start
   */
  private detectChirp(samples: Float32Array): void {
    // Simple chirp detection: look for dominant frequency in expected range
    // and check if it's rising (up-sweep part of chirp)
    const fftSize = 1024;
    if (samples.length < fftSize) return;

    // Find peak frequency using simple autocorrelation-based pitch detection
    const peakFreq = this.detectPeakFrequency(samples.subarray(0, fftSize));

    // Check if frequency is in chirp range
    const chirpLow = AUDIO.CHIRP_START_HZ;
    const chirpHigh = AUDIO.CHIRP_PEAK_HZ;

    if (peakFreq >= chirpLow && peakFreq <= chirpHigh) {
      // Check if frequency is rising (sweep)
      if (this.lastPeakFreq > 0 && peakFreq > this.lastPeakFreq + 50) {
        this.chirpSweepCount++;
        if (this.chirpSweepCount >= 3) {
          this.chirpDetected = true;
          console.log('[Decoder] Chirp detected! Audio starting from beginning.');
        }
      }
      this.lastPeakFreq = peakFreq;
    }
  }

  /**
   * Simple peak frequency detection using zero-crossing rate
   */
  private detectPeakFrequency(samples: Float32Array): number {
    // Count zero crossings to estimate frequency
    let zeroCrossings = 0;
    for (let i = 1; i < samples.length; i++) {
      if ((samples[i] >= 0 && samples[i - 1] < 0) ||
          (samples[i] < 0 && samples[i - 1] >= 0)) {
        zeroCrossings++;
      }
    }

    // Frequency = (crossings / 2) / duration
    const duration = samples.length / this.sampleRate;
    const freq = (zeroCrossings / 2) / duration;

    return freq;
  }
}
