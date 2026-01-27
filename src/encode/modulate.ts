/**
 * MFSK Modulation - converts bytes to audio
 * Phone-compatible mode: 8 tones (3 bits/symbol) in 600-3050 Hz range
 */
import { AUDIO, TONE_FREQUENCIES } from '../utils/constants';

// Simple seeded PRNG for reproducible frequency jitter
let jitterSeed = 12345;
function nextJitter(): number {
  jitterSeed = (jitterSeed * 1103515245 + 12345) & 0x7fffffff;
  return ((jitterSeed / 0x7fffffff) - 0.5) * 2 * AUDIO.FREQUENCY_JITTER;
}

function resetJitter(seed: number = 12345): void {
  jitterSeed = seed;
}

/**
 * Generate a single tone with Hann window fade in/out
 * Optional frequency jitter makes detection harder
 */
function generateTone(
  frequency: number,
  durationMs: number,
  sampleRate: number,
  guardMs: number = 0,
  applyJitter: boolean = false
): Float32Array {
  // Apply small frequency jitter for less detectability
  const actualFreq = applyJitter ? frequency + nextJitter() : frequency;

  const totalSamples = Math.floor((durationMs / 1000) * sampleRate);
  const guardSamples = Math.floor((guardMs / 1000) * sampleRate);
  const samples = new Float32Array(totalSamples);

  const angularFreq = (2 * Math.PI * actualFreq) / sampleRate;

  for (let i = 0; i < totalSamples; i++) {
    // Generate sine wave at slightly lower amplitude (less harsh)
    let sample = Math.sin(angularFreq * i) * 0.85;

    // Apply Hann window for fade in/out (guard interval)
    if (guardSamples > 0) {
      if (i < guardSamples) {
        // Fade in
        const t = i / guardSamples;
        sample *= 0.5 * (1 - Math.cos(Math.PI * t));
      } else if (i >= totalSamples - guardSamples) {
        // Fade out
        const t = (totalSamples - i) / guardSamples;
        sample *= 0.5 * (1 - Math.cos(Math.PI * t));
      }
    }

    samples[i] = sample;
  }

  return samples;
}

/**
 * Generate chirp signal for preamble (linear frequency sweep)
 */
function generateChirp(
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
    const instantFreq = startFreq + k * t;
    const phase = 2 * Math.PI * (startFreq * t + (k * t * t) / 2);
    result[i] = Math.sin(phase) * 0.8; // Slightly lower amplitude
  }

  return result;
}

/**
 * Generate the preamble signal
 * 1. Warmup: Steady tone to wake up audio path
 * 2. Chirp: Up-down sweep for AGC and attention
 * 3. Calibration: Known tones (repeated 2x)
 * 4. Sync word: 8-symbol pattern for reliable detection
 */
export function generatePreamble(sampleRate: number): Float32Array {
  const parts: Float32Array[] = [];

  // Warmup tone (200ms) - middle frequency to wake up audio path
  const warmupFreq = TONE_FREQUENCIES[Math.floor(TONE_FREQUENCIES.length / 2)];
  parts.push(generateTone(warmupFreq, AUDIO.WARMUP_DURATION_MS, sampleRate, 20));

  // Up chirp (400ms)
  parts.push(generateChirp(
    AUDIO.CHIRP_START_HZ,
    AUDIO.CHIRP_PEAK_HZ,
    AUDIO.CHIRP_DURATION_MS / 2,
    sampleRate
  ));

  // Down chirp (400ms)
  parts.push(generateChirp(
    AUDIO.CHIRP_PEAK_HZ,
    AUDIO.CHIRP_START_HZ,
    AUDIO.CHIRP_DURATION_MS / 2,
    sampleRate
  ));

  // Calibration tones (repeated for reliability)
  const calibrationRepeats = AUDIO.CALIBRATION_REPEATS || 2;
  for (let r = 0; r < calibrationRepeats; r++) {
    for (const toneIndex of AUDIO.CALIBRATION_TONES) {
      const freq = TONE_FREQUENCIES[toneIndex];
      parts.push(generateTone(freq, AUDIO.SYMBOL_DURATION_MS, sampleRate, AUDIO.GUARD_INTERVAL_MS));
    }
  }

  // Sync word (8 symbols) - use standard symbol duration for reliable detection
  for (const toneIndex of AUDIO.SYNC_PATTERN) {
    const freq = TONE_FREQUENCIES[toneIndex];
    parts.push(generateTone(freq, AUDIO.SYMBOL_DURATION_MS, sampleRate, AUDIO.GUARD_INTERVAL_MS));
  }

  // Concatenate all parts
  return concatenateSamples(parts);
}

/**
 * Convert bytes to symbols based on current audio mode
 * Uses BITS_PER_SYMBOL from audio settings:
 * - 4 tones = 2 bits/symbol
 * - 8 tones = 3 bits/symbol
 * - 16 tones = 4 bits/symbol
 */
function bytesToSymbols(bytes: Uint8Array): number[] {
  const bitsPerSymbol = AUDIO.BITS_PER_SYMBOL;
  const symbolMask = (1 << bitsPerSymbol) - 1;

  // Special case: 4 bits per symbol = exactly 2 symbols per byte
  if (bitsPerSymbol === 4) {
    const symbols: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      symbols.push((bytes[i] >> 4) & 0x0F);
      symbols.push(bytes[i] & 0x0F);
    }
    return symbols;
  }

  // General case: bit packing for 2 or 3 bits per symbol
  const symbols: number[] = [];
  let bitBuffer = 0;
  let bitsInBuffer = 0;

  for (let i = 0; i < bytes.length; i++) {
    bitBuffer = (bitBuffer << 8) | bytes[i];
    bitsInBuffer += 8;

    while (bitsInBuffer >= bitsPerSymbol) {
      bitsInBuffer -= bitsPerSymbol;
      symbols.push((bitBuffer >> bitsInBuffer) & symbolMask);
    }
  }

  // Handle remaining bits (pad with zeros)
  if (bitsInBuffer > 0) {
    symbols.push((bitBuffer << (bitsPerSymbol - bitsInBuffer)) & symbolMask);
  }

  return symbols;
}

/**
 * Calculate number of symbols needed for given bytes
 */
export function calculateSymbolCount(byteCount: number): number {
  const bitsPerSymbol = AUDIO.BITS_PER_SYMBOL;
  const totalBits = byteCount * 8;
  return Math.ceil(totalBits / bitsPerSymbol);
}

/**
 * Modulate bytes into audio samples using MFSK
 * Uses frequency jitter for less detectability
 */
export function modulateBytes(bytes: Uint8Array, sampleRate: number): Float32Array {
  const symbolDurationMs = AUDIO.SYMBOL_DURATION_MS;
  const guardMs = AUDIO.GUARD_INTERVAL_MS;

  // Convert bytes to 3-bit symbols
  const symbols = bytesToSymbols(bytes);

  // Generate audio for each symbol with jitter
  const parts: Float32Array[] = [];
  for (const symbol of symbols) {
    const freq = TONE_FREQUENCIES[symbol];
    parts.push(generateTone(freq, symbolDurationMs, sampleRate, guardMs, true));
  }

  return concatenateSamples(parts);
}

/**
 * Generate complete audio transmission
 *
 * IMPORTANT: No gaps between frames to maintain symbol timing alignment.
 * The decoder relies on continuous symbol extraction at fixed intervals.
 *
 * Optimizations:
 * - Single header copy for small messages (1 data frame)
 * - Shorter end marker
 */
export function generateTransmission(
  encodedFrames: Uint8Array[],
  sampleRate: number,
  includeHeaderRepeat?: boolean
): Float32Array {
  const parts: Float32Array[] = [];

  // Reset jitter seed for reproducible transmission
  resetJitter(12345);

  // Preamble (chirp + calibration + sync) - no jitter for reliable detection
  parts.push(generatePreamble(sampleRate));

  // Determine if we should repeat header
  // For small messages (1 data frame), skip repetition
  const numDataFrames = encodedFrames.length - 1;
  const repeatHeader = includeHeaderRepeat ?? (numDataFrames > 1);

  // Header frame
  const headerAudio = modulateBytes(encodedFrames[0], sampleRate);
  parts.push(headerAudio);

  if (repeatHeader) {
    // Second header copy for redundancy
    resetJitter(12345);
    parts.push(modulateBytes(encodedFrames[0], sampleRate));
  }

  // Data frames - no gaps between frames
  for (let i = 1; i < encodedFrames.length; i++) {
    parts.push(modulateBytes(encodedFrames[i], sampleRate));
  }

  // Short end marker: just sync pattern (no silence gap for speed)
  for (const toneIndex of [...AUDIO.SYNC_PATTERN]) {
    const freq = TONE_FREQUENCIES[toneIndex];
    parts.push(generateTone(freq, AUDIO.SYMBOL_DURATION_MS, sampleRate, AUDIO.GUARD_INTERVAL_MS, false));
  }

  return concatenateSamples(parts);
}

/**
 * Calculate transmission duration in seconds
 */
export function calculateDuration(totalEncodedBytes: number, sampleRate: number): number {
  // Preamble: warmup + chirp + calibration (repeated) + sync (8 symbols)
  const calibrationRepeats = AUDIO.CALIBRATION_REPEATS || 2;
  const calibrationSymbols = AUDIO.CALIBRATION_TONES.length * calibrationRepeats;
  const syncSymbols = AUDIO.SYNC_PATTERN.length;

  let durationMs = AUDIO.WARMUP_DURATION_MS + AUDIO.CHIRP_DURATION_MS;
  durationMs += (calibrationSymbols + syncSymbols) * AUDIO.SYMBOL_DURATION_MS;

  // End marker sync pattern
  durationMs += AUDIO.SYNC_PATTERN.length * AUDIO.SYMBOL_DURATION_MS;

  // Symbols: with 3-bit symbols, we need ceil(bytes * 8 / 3) symbols per message
  const totalSymbols = calculateSymbolCount(totalEncodedBytes);
  durationMs += totalSymbols * AUDIO.SYMBOL_DURATION_MS;

  return durationMs / 1000;
}

// Helper function to concatenate Float32Arrays
function concatenateSamples(arrays: Float32Array[]): Float32Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Float32Array(totalLength);

  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }

  return result;
}
