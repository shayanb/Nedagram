/**
 * Main decoding pipeline
 *
 * Flow: Audio → Multi-phase symbol extraction → Find sync → Decode
 *
 * Key insight: We don't know where symbol boundaries are when recording starts.
 * Solution: Try multiple phase offsets and find the one that produces valid patterns.
 */
import { signal } from '@preact/signals';
import { AUDIO, FRAME, PHONE_MODE, WIDEBAND_MODE, setAudioMode, type AudioMode } from '../utils/constants';
import { bytesToString } from '../utils/helpers';
import { detectSymbolWithThreshold, calculateSignalEnergy } from './detect';
import { decodeDataFEC, autoDetectAndDecodeHeader, autoDetectAndDecodeHeaderWithRedundancy, getHeaderSizes } from './fec';
import { parseHeaderFrame, parseDataFrame, FrameCollector, type HeaderInfo } from './deframe';
import { processPayload, type ProcessResult } from './decompress';
import { deinterleave, calculateInterleaverDepth } from '../encode/interleave';
import { sha256Hex } from '../lib/sha256';

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

  // Chirp detection
  private chirpDetected = false;
  private lastPeakFreq = 0;
  private chirpSweepCount = 0;

  // Audio mode auto-detection
  private detectedAudioMode: AudioMode | null = null;

  // Encryption
  private password: string | null = null;
  private pendingPayload: Uint8Array | null = null;  // Raw payload awaiting decryption

  // Header failure detection
  private consecutiveHeaderFailures = 0;
  private static readonly MAX_HEADER_FAILURES = 3;  // After this many failures, warn user

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

    // Buffer for ~10 seconds of audio
    this.sampleBuffer = new Float32Array(10 * sampleRate);

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
    this.headerRepeated = false;
    this.chirpDetected = false;
    this.lastPeakFreq = 0;
    this.chirpSweepCount = 0;
    this.detectedAudioMode = null;
    this.password = null;
    this.pendingPayload = null;
    this.consecutiveHeaderFailures = 0;

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

    // Detect chirp (frequency sweep) in the preamble
    if (!this.chirpDetected && this.state === 'detecting_preamble') {
      this.detectChirp(samples);
    }

    // Extract symbols for all phases
    this.extractSymbolsAllPhases();

    // Process based on state
    if (this.bestPhase < 0) {
      this.findBestPhase();
    } else if (this.state === 'receiving_header') {
      this.processHeader();
    } else if (this.state === 'receiving_data') {
      this.processDataFrame();
    }

    this.updateProgress();
  }

  private extractSymbolsAllPhases(): void {
    // For each phase, extract any new complete symbols
    for (let phase = 0; phase < NUM_PHASES; phase++) {
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

    for (let phase = 0; phase < NUM_PHASES; phase++) {
      const symbols = this.phaseSymbols[phase];

      if (symbols.length < 20) continue; // Need at least pattern + some header

      // Try each audio mode pattern
      for (const { mode, calib, sync, maxTone } of modes) {
        // Full pattern: calibration repeated + sync (16 symbols total)
        const fullCalib: number[] = [];
        for (let r = 0; r < calibRepeats; r++) {
          fullCalib.push(...calib);
        }
        const fullPattern = [...fullCalib, ...sync];
        const patternLen = fullPattern.length; // 16 symbols

        // Search for the full pattern with tolerance
        for (let i = 0; i <= symbols.length - patternLen; i++) {
          if (this.matchesPatternForMode(symbols, i, fullPattern, maxTone)) {
            this.bestPhase = phase;
            this.syncFoundAt = i + patternLen;
            this.state = 'receiving_header';
            this.detectedAudioMode = mode;

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

        // Try just sync pattern as fallback (8 symbols now)
        const syncLen = sync.length;
        for (let i = 0; i <= symbols.length - syncLen; i++) {
          if (this.matchesSyncPatternForMode(symbols, i, maxTone, syncLen)) {
            if (symbols.length > i + syncLen + 12) {
              this.bestPhase = phase;
              this.syncFoundAt = i + syncLen;
              this.state = 'receiving_header';
              this.detectedAudioMode = mode;

              setAudioMode(mode);
              this.updateSymbolTiming();

              console.log('[Decoder] Found', mode, 'sync-only at phase', phase, 'index', i);
              console.log('[Decoder] Pattern:', symbols.slice(i, i + syncLen));

              this.lastDebugInfo = `Sync found (${mode}, sync-only)!`;
              return;
            }
          }
        }

        // Try loose pattern matching (just calibration + first 4 sync symbols)
        for (let i = 0; i <= symbols.length - 8; i++) {
          if (this.matchesLoosePatternForMode(symbols, i, maxTone)) {
            this.bestPhase = phase;
            this.syncFoundAt = i + 8;
            this.state = 'receiving_header';
            this.detectedAudioMode = mode;

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
   */
  private updateSymbolTiming(): void {
    this.symbolSamples = Math.floor((AUDIO.SYMBOL_DURATION_MS / 1000) * this.sampleRate);
    this.guardSamples = Math.floor((AUDIO.GUARD_INTERVAL_MS / 1000) * this.sampleRate);
    this.phaseOffset = Math.floor(this.symbolSamples / NUM_PHASES);
    console.log('[Decoder] Updated timing for', this.detectedAudioMode, '- symbol:', this.symbolSamples, 'samples');
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
   */
  private matchesSyncPatternForMode(symbols: number[], startIndex: number, maxTone: number, syncLen: number = 8): boolean {
    const tolerance = maxTone > 10 ? 2 : 1;
    const minMatch = Math.max(4, syncLen - 2); // Need at least 6 of 8 to match

    let matches = 0;
    for (let i = 0; i < Math.min(syncLen, symbols.length - startIndex); i++) {
      const sym = symbols[startIndex + i];
      const isEven = i % 2 === 0;

      // Even positions should be low (0), odd positions should be high (maxTone)
      if (isEven && sym <= tolerance) matches++;
      if (!isEven && sym >= maxTone - tolerance) matches++;
    }

    return matches >= minMatch;
  }

  /**
   * Loose pattern matching for cross-device compatibility
   * Works for both phone (8 tones) and wideband (16 tones)
   */
  private matchesLoosePatternForMode(symbols: number[], startIndex: number, maxTone: number): boolean {
    const s = symbols.slice(startIndex, startIndex + 8);

    // For phone (maxTone=7): calib ~[0,2,5,7]
    // For wideband (maxTone=15): calib ~[0,5,10,15]
    const quarter = Math.floor(maxTone / 4);
    const half = Math.floor(maxTone / 2);
    const threeQuarter = Math.floor((maxTone * 3) / 4);
    const tolerance = maxTone > 10 ? 2 : 1;

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

  // Track whether header was sent twice (for multi-frame messages)
  private headerRepeated = false;

  private processHeader(): void {
    const symbols = this.phaseSymbols[this.bestPhase];

    // Get header sizes for both FEC modes
    const headerSizes = getHeaderSizes();
    const headerSymbolsNormal = this.calculateSymbolsForBytes(headerSizes.normal); // 28 bytes
    const headerSymbolsRobust = this.calculateSymbolsForBytes(headerSizes.robust); // 44 bytes

    const symbolsAfterSync = symbols.length - this.syncFoundAt;

    // Wait for enough symbols for the larger (robust) size to enable auto-detection
    if (symbolsAfterSync < headerSymbolsRobust) {
      this.lastDebugInfo = `Header: ${symbolsAfterSync}/${headerSymbolsRobust} symbols (auto-detect)`;
      return;
    }

    console.log('[Decoder] Got enough symbols for header auto-detection...');

    // Extract symbols for both sizes
    const headerStart = this.syncFoundAt;
    const symbolsNormal = symbols.slice(headerStart, headerStart + headerSymbolsNormal);
    const symbolsRobust = symbols.slice(headerStart, headerStart + headerSymbolsRobust);

    console.log('[Decoder] Header symbols (first 20):', symbolsNormal.slice(0, 20));

    // Convert to bytes for both sizes
    const bytesNormalRaw = this.symbolsToBytes(symbolsNormal, headerSizes.normal);
    const bytesRobustRaw = this.symbolsToBytes(symbolsRobust, headerSizes.robust);

    // Deinterleave bytes (reverse of encoder interleaving)
    const bytesNormal = deinterleave(
      bytesNormalRaw,
      calculateInterleaverDepth(headerSizes.normal),
      headerSizes.normal
    );
    const bytesRobust = deinterleave(
      bytesRobustRaw,
      calculateInterleaverDepth(headerSizes.robust),
      headerSizes.robust
    );

    console.log('[Decoder] Header bytes normal (first 10):', Array.from(bytesNormal.slice(0, 10)));
    console.log('[Decoder] Expected: [78, 49, ...] = "N1" magic');

    // Try auto-detection with single header first
    let decodeResult = autoDetectAndDecodeHeader(bytesNormal, bytesRobust);
    let detectedMode = decodeResult.detectedMode;
    const headerSymbols = detectedMode === 'normal' ? headerSymbolsNormal : headerSymbolsRobust;
    const headerBytes = detectedMode === 'normal' ? headerSizes.normal : headerSizes.robust;

    if (decodeResult.success) {
      const header = parseHeaderFrame(decodeResult.data);
      console.log('[Decoder] Parsed header:', header);

      if (header && header.crcValid) {
        // Check if this is a multi-frame message (header sent twice)
        this.headerRepeated = header.totalFrames > 1;

        if (this.headerRepeated && symbolsAfterSync >= headerSymbols * 2) {
          // Try second copy for better reliability with detected mode
          const symbols2Start = headerStart + headerSymbols;
          const symbols2Normal = symbols.slice(symbols2Start, symbols2Start + headerSymbolsNormal);
          const symbols2Robust = symbols.slice(symbols2Start, symbols2Start + headerSymbolsRobust);
          const bytes2NormalRaw = this.symbolsToBytes(symbols2Normal, headerSizes.normal);
          const bytes2RobustRaw = this.symbolsToBytes(symbols2Robust, headerSizes.robust);
          // Deinterleave second copy
          const bytes2Normal = deinterleave(
            bytes2NormalRaw,
            calculateInterleaverDepth(headerSizes.normal),
            headerSizes.normal
          );
          const bytes2Robust = deinterleave(
            bytes2RobustRaw,
            calculateInterleaverDepth(headerSizes.robust),
            headerSizes.robust
          );

          const decodeResult2 = autoDetectAndDecodeHeaderWithRedundancy(
            bytesNormal, bytesRobust, bytes2Normal, bytes2Robust
          );

          if (decodeResult2.success) {
            const header2 = parseHeaderFrame(decodeResult2.data);
            if (header2 && header2.crcValid) {
              console.log('[Decoder] Used redundant header copy');
              decodeResult = decodeResult2;
              detectedMode = decodeResult2.detectedMode;
            }
          }
        }

        this.headerInfo = header;
        this.frameCollector.setHeader(header);
        this.totalErrorsFixed += Math.max(0, decodeResult.correctedErrors);
        this.consecutiveHeaderFailures = 0;  // Reset failure counter on success

        this.state = 'receiving_data';
        this.lastDebugInfo = `Header OK (${detectedMode} FEC)! Frames: ${header.totalFrames}, Size: ${header.originalLength}`;
        console.log('[Decoder] Header valid! Mode:', detectedMode, 'Expecting', header.totalFrames, 'frames');
        return;
      } else {
        const reason = header ? 'CRC invalid' : 'Parse failed';
        console.log('[Decoder] Header invalid:', reason);
      }
    } else {
      console.log('[Decoder] Header FEC auto-detect failed');

      // If we have enough for second copy, try with redundancy
      const headerSymbolsMax = headerSymbolsRobust;
      if (symbolsAfterSync >= headerSymbolsMax * 2) {
        const symbols2Start = headerStart + headerSymbolsMax;
        const symbols2Normal = symbols.slice(symbols2Start, symbols2Start + headerSymbolsNormal);
        const symbols2Robust = symbols.slice(symbols2Start, symbols2Start + headerSymbolsRobust);
        const bytes2NormalRaw = this.symbolsToBytes(symbols2Normal, headerSizes.normal);
        const bytes2RobustRaw = this.symbolsToBytes(symbols2Robust, headerSizes.robust);
        // Deinterleave second copy
        const bytes2Normal = deinterleave(
          bytes2NormalRaw,
          calculateInterleaverDepth(headerSizes.normal),
          headerSizes.normal
        );
        const bytes2Robust = deinterleave(
          bytes2RobustRaw,
          calculateInterleaverDepth(headerSizes.robust),
          headerSizes.robust
        );

        const decodeResult2 = autoDetectAndDecodeHeaderWithRedundancy(
          bytesNormal, bytesRobust, bytes2Normal, bytes2Robust
        );

        if (decodeResult2.success) {
          const header = parseHeaderFrame(decodeResult2.data);
          if (header && header.crcValid) {
            this.headerInfo = header;
            this.headerRepeated = true;
            this.frameCollector.setHeader(header);
            this.totalErrorsFixed += Math.max(0, decodeResult2.correctedErrors);

            this.state = 'receiving_data';
            this.lastDebugInfo = `Header OK (${decodeResult2.detectedMode} FEC, redundant)! Frames: ${header.totalFrames}`;
            console.log('[Decoder] Header valid from redundant copy! Mode:', decodeResult2.detectedMode);
            return;
          }
        }
      }
    }

    // Header decode failed - reset and try again
    this.consecutiveHeaderFailures++;
    console.log('[Decoder] Header failure count:', this.consecutiveHeaderFailures);

    if (this.consecutiveHeaderFailures >= Decoder.MAX_HEADER_FAILURES) {
      this.lastDebugInfo = 'Poor signal - try moving closer or reducing noise';
    } else {
      this.lastDebugInfo = 'Header decode failed, retrying...';
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
    if (!this.headerInfo) return FRAME.PAYLOAD_SIZE;

    const totalPayload = this.headerInfo.payloadLength;

    // Match encoder's optimal frame size logic
    if (totalPayload <= 32) return 32;
    if (totalPayload <= 64) return 64;
    return FRAME.PAYLOAD_SIZE; // 128
  }

  /**
   * Calculate actual payload size for a specific frame (0-indexed)
   * Matches encoder's packetize logic exactly
   */
  private getActualFramePayloadSize(frameIndex: number): number {
    if (!this.headerInfo) return FRAME.PAYLOAD_SIZE;

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
    const headerEncodedBytes = FRAME.HEADER_SIZE + FRAME.RS_PARITY_SIZE; // 12 + 16 = 28
    const headerCopies = this.headerRepeated ? 2 : 1;
    const headerSymbols = this.calculateSymbolsForBytes(headerEncodedBytes) * headerCopies;
    const dataStart = this.syncFoundAt + headerSymbols;

    const framesExpected = this.headerInfo.totalFrames;
    const symbolsAvailable = symbols.length - dataStart;

    // Calculate symbol offset for each frame
    const frameSymbolOffsets: number[] = [0];
    for (let i = 0; i < framesExpected; i++) {
      const payloadSize = this.getActualFramePayloadSize(i);
      const frameBytes = 3 + payloadSize + FRAME.RS_PARITY_SIZE;
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

    // Process any complete frames we haven't attempted yet
    for (let f = 0; f < framesAvailable && f < framesExpected; f++) {
      // Skip frames we've already attempted
      if (this.framesAttempted.has(f)) continue;

      // Calculate this frame's actual payload size
      const thisFramePayloadSize = this.getActualFramePayloadSize(f);
      const thisFrameEncodedBytes = 3 + thisFramePayloadSize + FRAME.RS_PARITY_SIZE;

      // Frame position from pre-calculated offsets
      const frameStart = dataStart + frameSymbolOffsets[f];
      const frameEnd = dataStart + frameSymbolOffsets[f + 1];

      if (frameEnd > symbols.length) break;

      this.framesAttempted.add(f);

      const frameSymbolsArr = symbols.slice(frameStart, frameEnd);
      const frameBytesRaw = this.symbolsToBytes(frameSymbolsArr, thisFrameEncodedBytes);

      // Deinterleave frame bytes (reverse of encoder interleaving)
      const frameBytes = deinterleave(
        frameBytesRaw,
        calculateInterleaverDepth(thisFrameEncodedBytes),
        thisFrameEncodedBytes
      );

      console.log('[Decoder] Processing data frame', f, 'size:', thisFrameEncodedBytes, 'bytes (first 10):', Array.from(frameBytes.slice(0, 10)));
      console.log('[Decoder] Expected: [68, ...] = "D" magic');

      // Decode FEC
      const decodeResult = decodeDataFEC(frameBytes);

      if (decodeResult.success) {
        const frame = parseDataFrame(decodeResult.data);

        if (frame && frame.crcValid) {
          this.frameCollector.addFrame(frame.frameIndex, frame.payload, this.headerInfo.sessionId);
          this.totalErrorsFixed += Math.max(0, decodeResult.correctedErrors);

          console.log('[Decoder] Frame', frame.frameIndex, 'OK, payload:', frame.payloadLength, 'bytes');
          this.lastDebugInfo = `Frame ${frame.frameIndex}/${framesExpected} received`;

          // Check if complete
          if (this.frameCollector.isComplete()) {
            this.finalizeDecoding();
            return;
          }
        } else {
          console.log('[Decoder] Frame', f, 'parse failed');
          this.lastDebugInfo = `Frame ${f} parse failed`;
        }
      } else {
        console.log('[Decoder] Frame', f, 'FEC failed');
        this.lastDebugInfo = `Frame ${f} FEC failed - waiting for more data`;
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

      console.log('[Decoder] Complete! Data length:', data.length);

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
    this.headerRepeated = false;
    this.detectedAudioMode = null;
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
