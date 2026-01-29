/**
 * Convolutional Encoder for Nedagram v3
 *
 * Implements a rate 1/2, constraint length k=7 convolutional code
 * with optional puncturing to rate 2/3.
 *
 * Generator polynomials (industry standard - used by Voyager, CDMA, WiFi):
 * - G1 = 0x6D (109 decimal, 155 octal) = 1101101
 * - G2 = 0x4F (79 decimal, 117 octal)  = 1001111
 *
 * These correspond to the polynomial taps:
 * - G1: x^6 + x^5 + x^3 + x^2 + 1
 * - G2: x^6 + x^3 + x^2 + x + 1
 */

// Encoder configuration
export const CONVOLUTIONAL_CONFIG = {
  /** Constraint length (memory + 1) */
  K: 7,

  /** Number of memory elements */
  MEMORY: 6,

  /** Generator polynomial 1 */
  G1: 0x6D, // 1101101 binary

  /** Generator polynomial 2 */
  G2: 0x4F, // 1001111 binary

  /** Base code rate (before puncturing) */
  RATE_BASE: 0.5, // 1/2

  /** Punctured code rate */
  RATE_PUNCTURED: 2 / 3,

  /**
   * Puncture pattern for rate 2/3
   * 1 = keep bit, 0 = delete bit
   * Pattern: [G1, G2, G1, G2, G1, G2] → [1, 1, 0, 1, 1, 0]
   * Keeps 4 out of 6 bits = 2/3 rate
   */
  PUNCTURE_PATTERN: [1, 1, 0, 1, 1, 0],

  /** Number of states (2^memory) */
  NUM_STATES: 64, // 2^6
} as const;

/**
 * Convolutional Encoder
 *
 * Encodes input bits using a rate 1/2 convolutional code,
 * optionally punctured to rate 2/3.
 */
export class ConvolutionalEncoder {
  private state: number = 0;
  private punctureIndex: number = 0;
  private usePuncturing: boolean;

  constructor(usePuncturing: boolean = true) {
    this.usePuncturing = usePuncturing;
  }

  /**
   * Reset encoder state
   */
  reset(): void {
    this.state = 0;
    this.punctureIndex = 0;
  }

  /**
   * Encode a single input bit
   * Returns 1 or 2 output bits depending on puncturing
   */
  encodeBit(inputBit: number): number[] {
    // Shift input bit into state register
    const newState = ((this.state << 1) | (inputBit & 1)) & ((1 << CONVOLUTIONAL_CONFIG.MEMORY) - 1);

    // Include input bit for polynomial calculation
    const fullState = (inputBit << CONVOLUTIONAL_CONFIG.MEMORY) | this.state;

    // Calculate output bits using generator polynomials
    const out1 = this.parity(fullState & CONVOLUTIONAL_CONFIG.G1);
    const out2 = this.parity(fullState & CONVOLUTIONAL_CONFIG.G2);

    // Update state
    this.state = newState;

    if (this.usePuncturing) {
      return this.puncture(out1, out2);
    }

    return [out1, out2];
  }

  /**
   * Apply puncturing to output bits
   */
  private puncture(out1: number, out2: number): number[] {
    const pattern = CONVOLUTIONAL_CONFIG.PUNCTURE_PATTERN;
    const result: number[] = [];

    // Check if G1 output should be kept
    if (pattern[this.punctureIndex] === 1) {
      result.push(out1);
    }

    // Check if G2 output should be kept
    if (pattern[this.punctureIndex + 1] === 1) {
      result.push(out2);
    }

    // Advance puncture pattern index
    this.punctureIndex = (this.punctureIndex + 2) % pattern.length;

    return result;
  }

  /**
   * Calculate parity (XOR of all bits)
   */
  private parity(value: number): number {
    let p = 0;
    while (value) {
      p ^= value & 1;
      value >>= 1;
    }
    return p;
  }

  /**
   * Encode a byte array
   * Returns encoded bits as Uint8Array
   */
  encodeBytes(input: Uint8Array): Uint8Array {
    this.reset();

    const outputBits: number[] = [];

    // Encode each input bit
    for (const byte of input) {
      for (let i = 7; i >= 0; i--) {
        const bit = (byte >> i) & 1;
        outputBits.push(...this.encodeBit(bit));
      }
    }

    // Add tail bits to flush encoder (k-1 zeros)
    for (let i = 0; i < CONVOLUTIONAL_CONFIG.MEMORY; i++) {
      outputBits.push(...this.encodeBit(0));
    }

    // Pack bits into bytes
    return this.packBits(outputBits);
  }

  /**
   * Pack bit array into byte array
   */
  private packBits(bits: number[]): Uint8Array {
    const numBytes = Math.ceil(bits.length / 8);
    const output = new Uint8Array(numBytes);

    for (let i = 0; i < bits.length; i++) {
      const byteIndex = Math.floor(i / 8);
      const bitIndex = 7 - (i % 8);
      output[byteIndex] |= bits[i] << bitIndex;
    }

    return output;
  }

  /**
   * Calculate output size for given input size
   */
  static calculateOutputSize(inputBytes: number, usePuncturing: boolean = true): number {
    const inputBits = inputBytes * 8;
    const tailBits = CONVOLUTIONAL_CONFIG.MEMORY;
    const totalInputBits = inputBits + tailBits;

    if (usePuncturing) {
      // Rate 2/3: every 3 input bits → 4 output bits
      // Pattern [1,1,0,1,1,0] keeps 4 of 6 output bits per 3 input bits
      const outputBits = Math.ceil(totalInputBits * 4 / 3);
      return Math.ceil(outputBits / 8);
    } else {
      // Rate 1/2: every input bit → 2 output bits
      const outputBits = totalInputBits * 2;
      return Math.ceil(outputBits / 8);
    }
  }

  /**
   * Get current state (for testing)
   */
  getState(): number {
    return this.state;
  }
}

/**
 * Build state transition table for Viterbi decoder
 * For each state and input bit, returns [nextState, output1, output2]
 */
export function buildStateTransitionTable(): Map<number, Map<number, { nextState: number; outputs: [number, number] }>> {
  const table = new Map<number, Map<number, { nextState: number; outputs: [number, number] }>>();
  const numStates = CONVOLUTIONAL_CONFIG.NUM_STATES;

  for (let state = 0; state < numStates; state++) {
    const transitions = new Map<number, { nextState: number; outputs: [number, number] }>();

    for (let inputBit = 0; inputBit <= 1; inputBit++) {
      // Calculate next state
      const nextState = ((state << 1) | inputBit) & (numStates - 1);

      // Calculate outputs
      const fullState = (inputBit << CONVOLUTIONAL_CONFIG.MEMORY) | state;
      const out1 = parity(fullState & CONVOLUTIONAL_CONFIG.G1);
      const out2 = parity(fullState & CONVOLUTIONAL_CONFIG.G2);

      transitions.set(inputBit, { nextState, outputs: [out1, out2] });
    }

    table.set(state, transitions);
  }

  return table;
}

/**
 * Build reverse state transition table for traceback
 * For each state, returns the two possible previous states and input bits
 */
export function buildReverseTransitionTable(): Map<number, Array<{ prevState: number; inputBit: number }>> {
  const table = new Map<number, Array<{ prevState: number; inputBit: number }>>();
  const numStates = CONVOLUTIONAL_CONFIG.NUM_STATES;

  // Initialize
  for (let state = 0; state < numStates; state++) {
    table.set(state, []);
  }

  // Build reverse transitions
  for (let prevState = 0; prevState < numStates; prevState++) {
    for (let inputBit = 0; inputBit <= 1; inputBit++) {
      const nextState = ((prevState << 1) | inputBit) & (numStates - 1);
      table.get(nextState)!.push({ prevState, inputBit });
    }
  }

  return table;
}

/**
 * Standalone parity function
 */
function parity(value: number): number {
  let p = 0;
  while (value) {
    p ^= value & 1;
    value >>= 1;
  }
  return p;
}

/**
 * Encode bytes with convolutional code (convenience function)
 */
export function convolutionalEncode(
  input: Uint8Array,
  usePuncturing: boolean = true
): Uint8Array {
  const encoder = new ConvolutionalEncoder(usePuncturing);
  return encoder.encodeBytes(input);
}

/**
 * Get the depuncture pattern for decoding
 * Maps encoded bit positions to original (pre-puncture) positions
 * Returns -1 for positions that were punctured (need to be filled with erasures)
 */
export function getDepunctureMap(encodedLength: number): number[] {
  const pattern = CONVOLUTIONAL_CONFIG.PUNCTURE_PATTERN;
  const map: number[] = [];

  let encodedIndex = 0;
  let originalIndex = 0;

  while (encodedIndex < encodedLength) {
    const patternPos = originalIndex % pattern.length;

    if (pattern[patternPos] === 1) {
      map.push(originalIndex);
      encodedIndex++;
    }

    originalIndex++;
  }

  return map;
}

/**
 * Depuncture encoded bits (add erasures at punctured positions)
 * Returns array with 0.5 (soft uncertain) at punctured positions
 */
export function depunctureSoft(
  encodedBits: number[],
  originalLength: number
): number[] {
  const pattern = CONVOLUTIONAL_CONFIG.PUNCTURE_PATTERN;
  const result: number[] = [];

  let encodedIndex = 0;

  for (let i = 0; i < originalLength; i++) {
    const patternPos = i % pattern.length;

    if (pattern[patternPos] === 1 && encodedIndex < encodedBits.length) {
      result.push(encodedBits[encodedIndex]);
      encodedIndex++;
    } else {
      // Punctured position: insert erasure (0.5 = maximum uncertainty)
      result.push(0.5);
    }
  }

  return result;
}
