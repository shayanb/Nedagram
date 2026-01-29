/**
 * LFSR Scrambler for Nedagram v3
 *
 * Purpose: Ensures regular symbol transitions for better timing recovery
 * and DC balance. XORs data with pseudo-random sequence.
 *
 * Polynomial: x^15 + x + 1 (Fibonacci LFSR)
 * This is a maximal-length LFSR with period 2^15 - 1 = 32767
 * Taps at positions 15 and 1 (bits 14 and 0 in 0-indexed)
 */

// LFSR configuration
const LFSR_POLYNOMIAL = 0x4001; // x^15 + x + 1 (bits 14 and 0 set for taps)
const LFSR_SEED = 0x4A80;       // Fixed seed, known to both encoder and decoder
const LFSR_MASK = 0x7FFF;       // 15-bit mask

/**
 * LFSR (Linear Feedback Shift Register) implementation
 * Uses Fibonacci configuration with polynomial x^15 + x + 1
 */
class LFSR {
  private state: number;

  constructor(seed: number = LFSR_SEED) {
    // Ensure non-zero state (LFSR locks up at 0)
    this.state = (seed & LFSR_MASK) || LFSR_SEED;
  }

  /**
   * Generate next bit from LFSR (Fibonacci configuration)
   */
  nextBit(): number {
    // Output bit is LSB
    const outputBit = this.state & 1;

    // Calculate feedback: XOR of bits at positions 15 and 1
    // In 0-indexed 15-bit register: bits 14 and 0
    const bit14 = (this.state >> 14) & 1;
    const bit0 = this.state & 1;
    const feedback = bit14 ^ bit0;

    // Shift right and insert feedback at MSB (position 14)
    this.state = ((this.state >> 1) | (feedback << 14)) & LFSR_MASK;

    return outputBit;
  }

  /**
   * Generate next byte from LFSR
   */
  nextByte(): number {
    let byte = 0;
    for (let i = 0; i < 8; i++) {
      byte |= (this.nextBit() << i);
    }
    return byte;
  }

  /**
   * Reset LFSR to initial state
   */
  reset(seed: number = LFSR_SEED): void {
    this.state = (seed & LFSR_MASK) || LFSR_SEED;
  }

  /**
   * Get current state (for debugging)
   */
  getState(): number {
    return this.state;
  }
}

/**
 * Scramble data using LFSR
 *
 * @param data - Input bytes to scramble
 * @param seed - Optional custom seed (default: standard seed)
 * @returns Scrambled bytes
 */
export function scramble(data: Uint8Array, seed: number = LFSR_SEED): Uint8Array {
  const lfsr = new LFSR(seed);
  const output = new Uint8Array(data.length);

  for (let i = 0; i < data.length; i++) {
    output[i] = data[i] ^ lfsr.nextByte();
  }

  return output;
}

/**
 * Descramble data using LFSR
 *
 * Scrambling is symmetric (XOR with same sequence), so this is
 * identical to scramble(). Provided for API clarity.
 *
 * @param data - Scrambled bytes
 * @param seed - Optional custom seed (must match encoder)
 * @returns Original bytes
 */
export function descramble(data: Uint8Array, seed: number = LFSR_SEED): Uint8Array {
  // XOR is symmetric, so descramble === scramble
  return scramble(data, seed);
}

/**
 * Generate scrambling sequence (for testing/debugging)
 *
 * @param length - Number of bytes to generate
 * @param seed - Optional custom seed
 * @returns Pseudo-random byte sequence
 */
export function generateSequence(length: number, seed: number = LFSR_SEED): Uint8Array {
  const lfsr = new LFSR(seed);
  const output = new Uint8Array(length);

  for (let i = 0; i < length; i++) {
    output[i] = lfsr.nextByte();
  }

  return output;
}

// Export LFSR class for advanced usage
export { LFSR, LFSR_SEED, LFSR_POLYNOMIAL };
