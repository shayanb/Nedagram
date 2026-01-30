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
import { detectSymbolWithThreshold, calculateSignalEnergy } from './detect';
import { decodeDataFEC, decodeHeaderFEC, decodeHeaderWithRedundancy, getHeaderSize, getDataFrameSize } from './fec';
import { parseHeaderFrame, parseDataFrame, FrameCollector, type HeaderInfo } from './deframe';
import { processPayload, type ProcessResult } from './decompress';
import { deinterleave, calculateInterleaverDepth } from '../encode/interleave';
import { sha256Hex } from '../lib/sha256';
import { ChirpDetector } from '../lib/chirp';

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
  private phaseSymbols: number[][] = []; // Symbols for each phase
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

    // Initialize phase arrays
    for (let p = 0; p < NUM_PHASES; p++) {
      this.phaseSymbols[p] = [];
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

    for (let p = 0; p < NUM_PHASES; p++) {
      this.phaseSymbols[p] = [];
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
      // Silence detection: if no significant audio for 4 seconds after sync
      if (this.lastHighEnergyTime > 0 && (now - this.lastHighEnergyTime) > Decoder.SILENCE_TIMEOUT_MS) {
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
    this.extractSymbolsAllPhases();

    // Process based on state
    if (this.bestPhase < 0) {
      // Throttle pattern search to reduce CPU load during preamble detection
      this.patternSearchCounter++;
      if (this.patternSearchCounter >= Decoder.PATTERN_SEARCH_INTERVAL) {
        this.patternSearchCounter = 0;
        // If chirp is detected, use precise timing; otherwise fall back to pattern search
        if (this.chirpDetected && this.chirpEndSample > 0) {
          this.findBestPhaseFromChirp();
        } else {
          this.findBestPhase();
        }
      }
    } else if (this.state === 'receiving_header') {
      this.processHeader();
    } else if (this.state === 'receiving_data') {
      this.processDataFrame();
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

        // Get samples for this symbol (skip guard intervals)
        const analysisStart = symbolStart + this.guardSamples;
        const analysisLength = this.symbolSamples - this.guardSamples * 2;

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
          continue;
        }

        const symbolSamples = this.getBufferSamples(analysisStart, analysisLength);
        const tone = detectSymbolWithThreshold(symbolSamples, this.sampleRate, 0.10);

        if (tone >= 0) {
          this.phaseSymbols[phase].push(tone);
        } else {
          // Even if low confidence, we need to track position
          // Use -1 as placeholder or detect anyway with lower threshold
          const toneLow = detectSymbolWithThreshold(symbolSamples, this.sampleRate, 0.05);
          this.phaseSymbols[phase].push(toneLow >= 0 ? toneLow : 0);
        }
      }
    }
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

        if (matchRatio >= 0.7) {  // 70% match threshold
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

          if (this.matchesPatternForMode(symbols, i, fullPattern, maxTone)) {
            this.bestPhase = phase;
            this.syncFoundAt = syncPos;
            this.state = 'receiving_header';
            this.detectedAudioMode = mode;
            this.syncDetectedTime = Date.now();
            this.lastHighEnergyTime = Date.now();  // Reset silence timer

            // Set the audio mode globally
            setAudioMode(mode);
            this.updateSymbolTiming();

            console.log('[Decoder] Found', mode, 'calibration+sync at phase', phase, 'index', i);
            console.log('[Decoder] Pattern found:', symbols.slice(i, i + patternLen));
            console.log('[Decoder] Expected:', fullPattern);
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

          if (this.matchesSyncPatternForMode(symbols, i, maxTone, syncLen)) {
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
    // Require extra buffer to ensure we've had time to detect any full pattern first
    for (let phase = 0; phase < NUM_PHASES; phase++) {
      const symbols = this.phaseSymbols[phase];
      if (symbols.length < 20) continue;

      for (const { mode, maxTone } of modes) {
        for (let i = 0; i <= symbols.length - 8; i++) {
          const syncPos = i + 8;
          if (this.isSyncPositionFailed(phase, syncPos)) continue;

          // Require enough symbols that a full pattern at i-4 would have been detectable
          // Full pattern at (i-4) needs symbols up to (i-4+16) = (i+12)
          // This prevents matching a loose pattern before its containing full pattern is visible
          if (symbols.length < i + 16) continue;

          if (this.matchesLoosePatternForMode(symbols, i, maxTone)) {
            this.bestPhase = phase;
            this.syncFoundAt = syncPos;
            this.state = 'receiving_header';
            this.detectedAudioMode = mode;
            this.syncDetectedTime = Date.now();
            this.lastHighEnergyTime = Date.now();  // Reset silence timer

            setAudioMode(mode);
            this.updateSymbolTiming();

            console.log('[Decoder] Found', mode, 'loose pattern at phase', phase, 'index', i);
            console.log('[Decoder] Pattern found:', symbols.slice(i, i + 8));
            this.lastDebugInfo = `Sync found (${mode}, loose)!`;
            return;
          }
        }
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
    // Clear all phase symbol arrays
    for (let p = 0; p < NUM_PHASES; p++) {
      this.phaseSymbols[p] = [];
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
   * Pattern matching for specific mode
   */
  private matchesPatternForMode(symbols: number[], startIndex: number, pattern: number[], maxTone: number): boolean {
    let matches = 0;
    const tolerance = maxTone > 10 ? 2 : 1; // Larger tolerance for wideband (16 tones)

    for (let i = 0; i < pattern.length; i++) {
      if (symbols[startIndex + i] === pattern[i]) {
        matches++;
      } else if (Math.abs(symbols[startIndex + i] - pattern[i]) <= tolerance) {
        matches += 0.5; // Partial match for adjacent tones
      }
    }
    return matches >= pattern.length - 1; // Allow 1 mismatch
  }

  /**
   * Sync pattern matching for specific mode
   * Sync: [low, high, low, high, ...] alternating pattern
   * Made stricter to avoid false positives
   */
  private matchesSyncPatternForMode(symbols: number[], startIndex: number, maxTone: number, syncLen: number = 8): boolean {
    // Phone mode (4 tones): require exact 8/8 match - less margin for error
    // Wideband mode (16 tones): allow 7/8 - more tones means more potential drift
    const minMatch = maxTone > 10 ? syncLen - 1 : syncLen;

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
  private matchesLoosePatternForMode(symbols: number[], startIndex: number, maxTone: number): boolean {
    const s = symbols.slice(startIndex, startIndex + 8);
    if (s.length < 8) return false;

    // Phone mode (maxTone=3): require exact calibration [0,1,2,3] and exact sync [0,3,0,3]
    // Wideband mode (maxTone=15): allow more tolerance
    const isPhoneMode = maxTone <= 7;

    if (isPhoneMode) {
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
    const tolerance = 2;

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

    const headerSymbolsArr = symbols.slice(headerStart, headerStart + headerSymbols);
    const bytesRaw = this.symbolsToBytes(headerSymbolsArr, headerBytes);
    const bytes = deinterleave(
      bytesRaw,
      calculateInterleaverDepth(headerBytes),
      headerBytes
    );

    // Try primary decode
    let decodeResult = decodeHeaderFEC(bytes);

    if (decodeResult.success) {
      const header = parseHeaderFrame(decodeResult.data);
      if (header && header.crcValid) {
        return { header, correctedErrors: decodeResult.correctedErrors, redundant: false };
      }
    }

    // Try with redundant copy if available
    const symbols2Start = headerStart + headerSymbols;
    if (symbols2Start + headerSymbols <= symbols.length) {
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
          return { header, correctedErrors: decodeResult2.correctedErrors, redundant: true };
        }
      }
    }

    return null;
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

    // Try header extraction with offset retries
    // First try the detected position, then ±1, ±2 symbol offsets
    const offsets = [0, -1, 1, -2, 2];

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

    // Log what we tried (for debugging)
    const headerStart = this.syncFoundAt;
    const headerSymbolsArr = symbols.slice(headerStart, headerStart + headerSymbols);
    console.log('[Decoder] Header symbols (first 20):', headerSymbolsArr.slice(0, 20));

    const bytesRaw = this.symbolsToBytes(headerSymbolsArr, headerBytes);
    const bytes = deinterleave(
      bytesRaw,
      calculateInterleaverDepth(headerBytes),
      headerBytes
    );
    console.log('[Decoder] Header bytes (first 10):', Array.from(bytes.slice(0, 10)));
    console.log('[Decoder] Expected: [78, 51, ...] = "N3" magic (v3 protocol)');

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
      console.log('[Decoder] Header FEC decode failed');

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

    console.log('[Decoder] Header FEC decode failed after trying', offsets.length * phasesToTry.length, 'combinations');

    // Header decode failed - reset and try again
    this.consecutiveHeaderFailures++;
    console.log('[Decoder] Header failure count:', this.consecutiveHeaderFailures);

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
      const errorMsg = this.modeRetryAttempted
        ? 'Decoding failed in both modes. Try moving closer or reducing background noise.'
        : 'Too many header decode failures. Check signal quality and try again.';

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
    return end - start;
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
      const thisFrameEncodedBytes = getDataFrameSize(thisFramePayloadSize);
      const frameSymCount = frameSymbolOffsets[f + 1] - frameSymbolOffsets[f];

      // Frame position from pre-calculated offsets
      const baseFrameStart = dataStart + frameSymbolOffsets[f];

      // Try different offsets and phases
      let decoded = false;

      // First try the current phase with different offsets
      for (const offset of dataOffsets) {
        if (decoded) break;

        const frameStart = baseFrameStart + offset;
        const frameEnd = frameStart + frameSymCount;

        if (frameStart < 0 || frameEnd > symbols.length) continue;

        const frameSymbolsArr = symbols.slice(frameStart, frameEnd);
        const frameBytesRaw = this.symbolsToBytes(frameSymbolsArr, thisFrameEncodedBytes);
        const frameBytes = deinterleave(
          frameBytesRaw,
          calculateInterleaverDepth(thisFrameEncodedBytes),
          thisFrameEncodedBytes
        );

        if (offset === 0) {
          console.log('[Decoder] Processing data frame', f, 'size:', thisFrameEncodedBytes, 'bytes (first 10):', Array.from(frameBytes.slice(0, 10)));
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

            if (offset !== 0) {
              console.log('[Decoder] Frame', f, 'recovered with offset', offset);
            }
            console.log('[Decoder] Frame', frame.frameIndex, 'OK, payload:', frame.payloadLength, 'bytes');
            this.lastDebugInfo = `Frame ${frame.frameIndex}/${framesExpected} received`;

            if (this.frameCollector.isComplete()) {
              this.finalizeDecoding();
              return;
            }
            break;
          }
        }
      }

      // If still not decoded, try other phases with offsets
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
                this.frameCollector.addFrame(frame.frameIndex, frame.payload, this.headerInfo.sessionId);
                this.totalErrorsFixed += Math.max(0, decodeResult.correctedErrors);
                this.failedDataFrames.delete(f);
                decoded = true;

                console.log('[Decoder] Frame', f, 'recovered with phase', phase, 'offset', offset);
                console.log('[Decoder] Frame', frame.frameIndex, 'OK, payload:', frame.payloadLength, 'bytes');
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
    const symbolsWithBuffer = Math.floor(totalExpectedSymbols * Decoder.SYMBOL_BUFFER_RATIO);

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

      // Process payload: decrypt (if needed) then decompress
      const result = await processPayload(
        payload,
        this.headerInfo.encrypted,
        this.headerInfo.compressed,
        this.headerInfo.compressionAlgo,
        this.headerInfo.originalLength,
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
