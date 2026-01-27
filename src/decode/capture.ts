/**
 * Audio capture and sample buffering for decoding
 */
import { AUDIO } from '../utils/constants';

/**
 * Sample buffer for collecting audio data
 * Handles windowing for symbol detection
 */
export class SampleBuffer {
  private buffer: Float32Array;
  private writeIndex = 0;
  private sampleRate: number;
  private symbolSamples: number;
  private guardSamples: number;

  constructor(sampleRate: number, bufferSeconds: number = 5) {
    this.sampleRate = sampleRate;
    this.symbolSamples = Math.floor((AUDIO.SYMBOL_DURATION_MS / 1000) * sampleRate);
    this.guardSamples = Math.floor((AUDIO.GUARD_INTERVAL_MS / 1000) * sampleRate);

    // Allocate buffer for specified duration
    const bufferSize = Math.floor(bufferSeconds * sampleRate);
    this.buffer = new Float32Array(bufferSize);
  }

  /**
   * Add samples to buffer
   */
  addSamples(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.buffer.length;
    }
  }

  /**
   * Get samples for a symbol at given offset from current position
   * @param symbolsBack How many symbols back from current position
   * @returns Float32Array of samples for that symbol
   */
  getSymbolSamples(symbolsBack: number = 0): Float32Array {
    const symbolTotal = this.symbolSamples;
    const startOffset = (symbolsBack + 1) * symbolTotal;

    const result = new Float32Array(symbolTotal - this.guardSamples * 2);

    // Skip guard intervals, get middle portion of symbol
    const readStart = this.writeIndex - startOffset + this.guardSamples;

    for (let i = 0; i < result.length; i++) {
      let idx = (readStart + i) % this.buffer.length;
      if (idx < 0) idx += this.buffer.length;
      result[i] = this.buffer[idx];
    }

    return result;
  }

  /**
   * Get raw samples from buffer
   */
  getSamples(count: number, offsetBack: number = 0): Float32Array {
    const result = new Float32Array(count);
    const readStart = this.writeIndex - offsetBack - count;

    for (let i = 0; i < count; i++) {
      let idx = (readStart + i) % this.buffer.length;
      if (idx < 0) idx += this.buffer.length;
      result[i] = this.buffer[idx];
    }

    return result;
  }

  /**
   * Get number of samples per symbol
   */
  getSymbolSampleCount(): number {
    return this.symbolSamples;
  }

  /**
   * Clear buffer
   */
  clear(): void {
    this.buffer.fill(0);
    this.writeIndex = 0;
  }
}

/**
 * Symbol extractor - extracts symbols from continuous audio stream
 */
export class SymbolExtractor {
  private sampleBuffer: SampleBuffer;
  private sampleCount = 0;
  private symbolSamples: number;
  private lastSymbolIndex = -1;

  constructor(sampleRate: number) {
    this.sampleBuffer = new SampleBuffer(sampleRate);
    this.symbolSamples = Math.floor((AUDIO.SYMBOL_DURATION_MS / 1000) * sampleRate);
  }

  /**
   * Process incoming samples
   * @param samples Audio samples to process
   * @param onSymbol Callback for each complete symbol detected
   */
  process(
    samples: Float32Array,
    onSymbol: (samples: Float32Array, symbolIndex: number) => void
  ): void {
    this.sampleBuffer.addSamples(samples);
    this.sampleCount += samples.length;

    // Check if we have a new complete symbol
    const currentSymbolIndex = Math.floor(this.sampleCount / this.symbolSamples);

    while (this.lastSymbolIndex < currentSymbolIndex - 1) {
      this.lastSymbolIndex++;
      const symbolSamples = this.sampleBuffer.getSymbolSamples(
        currentSymbolIndex - this.lastSymbolIndex - 1
      );
      onSymbol(symbolSamples, this.lastSymbolIndex);
    }
  }

  /**
   * Get underlying sample buffer
   */
  getBuffer(): SampleBuffer {
    return this.sampleBuffer;
  }

  /**
   * Reset extractor state
   */
  reset(): void {
    this.sampleBuffer.clear();
    this.sampleCount = 0;
    this.lastSymbolIndex = -1;
  }
}
