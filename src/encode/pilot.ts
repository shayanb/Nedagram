/**
 * MFSK Pilot Sequence for Music Steganography Mode
 *
 * Replaces the chirp preamble with a known MFSK symbol pattern
 * that can be detected via soft-decision FFT correlation.
 * Works blind (receiver does not need the cover music).
 */
import { AUDIO, TONE_FREQUENCIES } from '../utils/constants';

// Pilot sequence: 24 symbols with good auto-correlation properties
// Contains all tones equally, palindrome structure for low sidelobes
export const PILOT_SEQUENCE_PHONE = [
  0, 1, 2, 3, 3, 2, 1, 0,   // ascending + descending
  0, 2, 1, 3, 3, 1, 2, 0,   // interleaved pattern
  0, 1, 2, 3, 3, 2, 1, 0,   // repeat for robustness
];

export const PILOT_SEQUENCE_WIDEBAND = [
  0, 5, 10, 15, 15, 10, 5, 0,
  0, 10, 5, 15, 15, 5, 10, 0,
  0, 5, 10, 15, 15, 10, 5, 0,
];

/**
 * Get the full pilot+sync pattern for current audio mode
 * Returns: [24 pilot symbols] + [8 sync symbols]
 */
export function getFullPilotPattern(): number[] {
  const isPhone = AUDIO.NUM_TONES === 4;
  const pilot = isPhone ? PILOT_SEQUENCE_PHONE : PILOT_SEQUENCE_WIDEBAND;
  return [...pilot, ...AUDIO.SYNC_PATTERN];
}

/**
 * Generate pilot preamble audio (replaces chirp-based preamble)
 *
 * Structure: [pilot tones × 24] [sync pattern × 8]
 * Total: 32 symbols (~2s at phone mode, ~1.4s at wideband)
 */
export function generatePilotPreamble(
  sampleRate: number,
  amplitude: number = 0.85,
): Float32Array {
  const pattern = getFullPilotPattern();
  const symbolDurationMs = AUDIO.SYMBOL_DURATION_MS;
  const guardMs = AUDIO.GUARD_INTERVAL_MS;
  // Match the modulator: each symbol is symbolDurationMs samples with Hann guard fade
  // No extra silence between symbols (guard is part of the symbol window)
  const symbolSamples = Math.floor((symbolDurationMs / 1000) * sampleRate);
  const guardSamples = Math.floor((guardMs / 1000) * sampleRate);

  const totalSamples = pattern.length * symbolSamples;
  const audio = new Float32Array(totalSamples);

  for (let i = 0; i < pattern.length; i++) {
    const freq = TONE_FREQUENCIES[pattern[i]];
    const offset = i * symbolSamples;

    // Generate tone with Hann fade (same as modulate.ts generateTone)
    for (let s = 0; s < symbolSamples; s++) {
      let sample = Math.sin(2 * Math.PI * freq * s / sampleRate) * amplitude;

      if (guardSamples > 0) {
        if (s < guardSamples) {
          sample *= 0.5 * (1 - Math.cos(Math.PI * s / guardSamples));
        } else if (s >= symbolSamples - guardSamples) {
          sample *= 0.5 * (1 - Math.cos(Math.PI * (symbolSamples - s) / guardSamples));
        }
      }

      audio[offset + s] = sample;
    }
  }

  return audio;
}
