/**
 * Preamble and sync detection
 *
 * Detects the sync word [0, 15, 0, 15] pattern by looking for
 * the distinctive low-high-low-high frequency pattern using
 * sliding window analysis.
 */
import { detectSymbol, calculateSignalEnergy } from './detect';
import { AUDIO, TONE_FREQUENCIES } from '../utils/constants';

export type SyncState =
  | 'idle'
  | 'waiting_signal'
  | 'detecting_preamble'
  | 'synchronized';

export interface SyncResult {
  state: SyncState;
  confidence: number;
  debugInfo?: string;
}

/**
 * Sync detector - looks for the sync word pattern using sliding windows
 */
export class SyncDetector {
  private state: SyncState = 'idle';
  private sampleRate: number;
  private lastDebugInfo = '';

  // Accumulate samples for sliding window analysis
  private sampleBuffer: Float32Array;
  private bufferWriteIndex = 0;
  private bufferFilled = false;

  // Track detected tones over time
  private detectedTones: Array<{tone: number; confidence: number; timestamp: number}> = [];
  private detectionTimestamp = 0;

  // Symbol timing
  private symbolSamples: number;
  private windowSamples: number;
  private windowOverlap: number;

  constructor(sampleRate: number) {
    this.sampleRate = sampleRate;

    // Symbol is 40ms
    this.symbolSamples = Math.floor((AUDIO.SYMBOL_DURATION_MS / 1000) * sampleRate);

    // Use 30ms analysis windows for reliable FFT
    this.windowSamples = Math.floor((30 / 1000) * sampleRate);

    // Overlap windows by 50% for better time resolution
    this.windowOverlap = Math.floor(this.windowSamples / 2);

    // Buffer enough for several symbols
    const bufferDuration = 1; // 1 second
    this.sampleBuffer = new Float32Array(Math.floor(bufferDuration * sampleRate));
  }

  reset(): void {
    this.state = 'idle';
    this.lastDebugInfo = '';
    this.bufferWriteIndex = 0;
    this.bufferFilled = false;
    this.sampleBuffer.fill(0);
    this.detectedTones = [];
    this.detectionTimestamp = 0;
  }

  process(samples: Float32Array): SyncResult {
    // Add samples to our buffer
    for (let i = 0; i < samples.length; i++) {
      this.sampleBuffer[this.bufferWriteIndex] = samples[i];
      this.bufferWriteIndex++;

      if (this.bufferWriteIndex >= this.sampleBuffer.length) {
        this.bufferWriteIndex = 0;
        this.bufferFilled = true;
      }
    }

    // Calculate overall signal energy
    const energy = calculateSignalEnergy(samples, this.sampleRate);

    // Wait for signal
    if (this.state === 'idle') {
      if (energy > 0.03) {
        this.state = 'waiting_signal';
        this.lastDebugInfo = `Signal detected (energy: ${energy.toFixed(3)})`;
      }
      return { state: this.state, confidence: 0, debugInfo: this.lastDebugInfo };
    }

    // Process sliding windows to detect tones
    const windowsToProcess = Math.floor(samples.length / this.windowOverlap);

    for (let w = 0; w < windowsToProcess; w++) {
      const windowEnd = this.bufferWriteIndex - (windowsToProcess - w - 1) * this.windowOverlap;
      const windowStart = windowEnd - this.windowSamples;

      if (windowStart < 0 && !this.bufferFilled) continue;

      // Extract window samples
      const windowSamples = new Float32Array(this.windowSamples);
      for (let i = 0; i < this.windowSamples; i++) {
        let idx = windowStart + i;
        if (idx < 0) idx += this.sampleBuffer.length;
        if (idx >= this.sampleBuffer.length) idx -= this.sampleBuffer.length;
        windowSamples[i] = this.sampleBuffer[idx];
      }

      // Detect tone in this window
      const detection = detectSymbol(windowSamples, this.sampleRate);

      if (detection.confidence > 0.15 && detection.tone >= 0 && detection.tone < 16) {
        this.detectionTimestamp++;
        this.detectedTones.push({
          tone: detection.tone,
          confidence: detection.confidence,
          timestamp: this.detectionTimestamp
        });

        // Keep only recent detections (last ~500ms worth)
        const maxDetections = Math.floor(500 / (this.windowOverlap / this.sampleRate * 1000));
        if (this.detectedTones.length > maxDetections) {
          this.detectedTones.shift();
        }

        this.state = 'detecting_preamble';
      }
    }

    // Look for sync pattern in detected tones
    const syncResult = this.findSyncPattern();

    if (syncResult.found) {
      this.state = 'synchronized';
      this.lastDebugInfo = `Sync found! Pattern detected at confidence ${syncResult.confidence.toFixed(2)}`;
      return { state: 'synchronized', confidence: syncResult.confidence, debugInfo: this.lastDebugInfo };
    }

    // Build debug info showing recent tones
    const recentTones = this.detectedTones.slice(-10).map(d => d.tone);
    const expectedPattern = AUDIO.SYNC_PATTERN.slice(0, 4).join(',') + '...';
    this.lastDebugInfo = `Energy: ${energy.toFixed(3)}, Recent: [${recentTones.join(', ')}], Waiting for [${expectedPattern}]`;

    const patternConfidence = this.calculatePatternConfidence();
    return { state: this.state, confidence: patternConfidence, debugInfo: this.lastDebugInfo };
  }

  private findSyncPattern(): { found: boolean; confidence: number } {
    const syncLen = AUDIO.SYNC_PATTERN.length; // 8 symbols
    const minMatch = Math.max(4, syncLen - 2); // Need at least 6 of 8 to match

    if (this.detectedTones.length < minMatch) {
      return { found: false, confidence: 0 };
    }

    // Consolidate consecutive similar detections into symbols
    const symbols = this.consolidateToSymbols();

    if (symbols.length < minMatch) {
      return { found: false, confidence: 0 };
    }

    // Look for sync pattern (8 symbols now)
    for (let i = 0; i <= symbols.length - minMatch; i++) {
      const pattern = symbols.slice(i, i + syncLen).map(s => s.tone);

      if (this.matchesSyncPattern(pattern)) {
        const matchLen = Math.min(pattern.length, syncLen);
        const avgConfidence = symbols.slice(i, i + matchLen).reduce((sum, s) => sum + s.confidence, 0) / matchLen;
        return { found: true, confidence: avgConfidence };
      }
    }

    return { found: false, confidence: 0 };
  }

  private consolidateToSymbols(): Array<{tone: number; confidence: number}> {
    if (this.detectedTones.length === 0) return [];

    const symbols: Array<{tone: number; confidence: number}> = [];
    let current = { tone: this.detectedTones[0].tone, confidence: this.detectedTones[0].confidence, count: 1 };

    for (let i = 1; i < this.detectedTones.length; i++) {
      const det = this.detectedTones[i];

      // If same tone or within 1, accumulate
      if (Math.abs(det.tone - current.tone) <= 1) {
        current.confidence = Math.max(current.confidence, det.confidence);
        current.count++;
      } else {
        // Different tone - save current if it has enough detections
        if (current.count >= 2) {
          symbols.push({ tone: current.tone, confidence: current.confidence });
        }
        current = { tone: det.tone, confidence: det.confidence, count: 1 };
      }
    }

    // Don't forget the last one
    if (current.count >= 2) {
      symbols.push({ tone: current.tone, confidence: current.confidence });
    }

    return symbols;
  }

  private matchesSyncPattern(pattern: number[]): boolean {
    // Expected: 8-symbol alternating pattern [0,max,0,max,0,max,0,max]
    const expected = AUDIO.SYNC_PATTERN;
    const syncLen = expected.length;
    const matchLen = Math.min(pattern.length, syncLen);
    const minRequired = Math.max(4, syncLen - 2); // Need 6 of 8 for 8-symbol pattern

    // Strict match
    let strictMatches = 0;
    for (let i = 0; i < matchLen; i++) {
      if (pattern[i] === expected[i]) {
        strictMatches++;
      }
    }
    if (strictMatches >= minRequired) return true;

    // Allow some tolerance for frequency drift
    let tolerantMatches = 0;
    for (let i = 0; i < matchLen; i++) {
      const diff = Math.abs(pattern[i] - expected[i]);
      if (diff <= 1) {
        tolerantMatches++;
      }
    }
    if (tolerantMatches >= minRequired) return true;

    // Check for alternating low/high pattern (works for both phone and wideband)
    const maxTone = AUDIO.NUM_TONES - 1;
    const lowThreshold = Math.floor(maxTone * 0.2);
    const highThreshold = Math.floor(maxTone * 0.8);

    let alternatingMatches = 0;
    for (let i = 0; i < matchLen; i++) {
      const isEven = i % 2 === 0;
      if (isEven && pattern[i] <= lowThreshold) alternatingMatches++;
      if (!isEven && pattern[i] >= highThreshold) alternatingMatches++;
    }

    return alternatingMatches >= minRequired;
  }

  private calculatePatternConfidence(): number {
    const symbols = this.consolidateToSymbols();
    if (symbols.length < 2) return 0;

    const last4 = symbols.slice(-4);
    let patternScore = 0;

    // Check for alternating low/high pattern
    for (let i = 0; i < last4.length - 1; i++) {
      const curr = last4[i].tone;
      const next = last4[i + 1].tone;
      // Low to high or high to low transition
      if ((curr <= 3 && next >= 12) || (curr >= 12 && next <= 3)) {
        patternScore += 0.25;
      }
    }

    return Math.min(patternScore, 1);
  }

  getState(): SyncState {
    return this.state;
  }

  isSynchronized(): boolean {
    return this.state === 'synchronized';
  }

  getDebugInfo(): string {
    return this.lastDebugInfo;
  }
}
