/**
 * Soft-Decision Viterbi Decoder for Nedagram v3
 *
 * Decodes convolutional codes using the Viterbi algorithm with
 * soft-decision inputs for improved error correction.
 *
 * The Viterbi algorithm finds the most likely sequence of states
 * (and thus input bits) given the received (possibly noisy) output sequence.
 */

import {
  CONVOLUTIONAL_CONFIG,
  buildStateTransitionTable,
  depunctureSoft,
} from '../encode/convolutional';

// Type for path metric (accumulated error)
type PathMetric = number;

// Infinity-like value for impossible paths
const METRIC_INFINITY = 1e9;

/**
 * Soft-Decision Viterbi Decoder
 */
export class ViterbiDecoder {
  private readonly numStates: number;
  private readonly memory: number;
  private readonly tracebackDepth: number;

  // State transition table: [state][input] -> {nextState, outputs}
  private readonly transitions: Map<number, Map<number, { nextState: number; outputs: [number, number] }>>;

  // Reverse transitions for traceback: [state] -> [{prevState, inputBit}]
  private readonly reverseTransitions: Map<number, Array<{ prevState: number; inputBit: number }>>;

  constructor() {
    this.numStates = CONVOLUTIONAL_CONFIG.NUM_STATES;
    this.memory = CONVOLUTIONAL_CONFIG.MEMORY;
    this.tracebackDepth = 5 * CONVOLUTIONAL_CONFIG.K; // Standard: 5 * constraint length

    // Build transition tables
    this.transitions = buildStateTransitionTable();
    this.reverseTransitions = this.buildReverseTransitions();
  }

  /**
   * Build reverse transition table for traceback
   */
  private buildReverseTransitions(): Map<number, Array<{ prevState: number; inputBit: number }>> {
    const table = new Map<number, Array<{ prevState: number; inputBit: number }>>();

    for (let state = 0; state < this.numStates; state++) {
      table.set(state, []);
    }

    for (let prevState = 0; prevState < this.numStates; prevState++) {
      const stateTransitions = this.transitions.get(prevState)!;

      for (const [inputBit, { nextState }] of stateTransitions) {
        table.get(nextState)!.push({ prevState, inputBit });
      }
    }

    return table;
  }

  /**
   * Decode soft-decision input
   *
   * @param softBits - Array of soft values (0.0 = definitely 0, 1.0 = definitely 1)
   * @param isPunctured - Whether input was punctured (needs depuncturing)
   * @param expectedOutputBits - Expected number of output bits (for depuncturing)
   * @returns Decoded bytes
   */
  decode(
    softBits: number[],
    isPunctured: boolean = true,
    expectedOutputBits?: number
  ): Uint8Array {
    // Depuncture if needed, or trim to expected length
    let bits = softBits;
    if (isPunctured && expectedOutputBits !== undefined) {
      bits = depunctureSoft(softBits, expectedOutputBits);
    } else if (expectedOutputBits !== undefined && softBits.length > expectedOutputBits) {
      // Trim padding bits when not puncturing
      bits = softBits.slice(0, expectedOutputBits);
    }

    // Ensure even number of bits (pairs for rate 1/2)
    if (bits.length % 2 !== 0) {
      bits = [...bits, 0.5]; // Add uncertain bit
    }

    const numPairs = bits.length / 2;

    // Path metrics for current and previous step
    let prevMetrics = new Float32Array(this.numStates).fill(METRIC_INFINITY);
    let currMetrics = new Float32Array(this.numStates);

    // History for traceback: [step][state] = previous state
    const history: Uint8Array[] = [];

    // Initialize: start in state 0
    prevMetrics[0] = 0;

    // Forward pass: compute path metrics
    for (let step = 0; step < numPairs; step++) {
      const soft1 = bits[step * 2];     // First bit of pair
      const soft2 = bits[step * 2 + 1]; // Second bit of pair

      currMetrics.fill(METRIC_INFINITY);
      const stepHistory = new Uint8Array(this.numStates);

      for (let state = 0; state < this.numStates; state++) {
        const prevs = this.reverseTransitions.get(state)!;

        for (const { prevState, inputBit } of prevs) {
          // Get expected outputs for this transition
          const { outputs } = this.transitions.get(prevState)!.get(inputBit)!;
          const [expected1, expected2] = outputs;

          // Calculate branch metric (Euclidean distance for soft decision)
          const branchMetric = this.calculateBranchMetric(
            soft1, soft2,
            expected1, expected2
          );

          // Total metric for this path
          const totalMetric = prevMetrics[prevState] + branchMetric;

          // Keep path with lower metric (ACS: Add-Compare-Select)
          if (totalMetric < currMetrics[state]) {
            currMetrics[state] = totalMetric;
            stepHistory[state] = prevState;
          }
        }
      }

      history.push(stepHistory);

      // Swap metrics
      [prevMetrics, currMetrics] = [currMetrics, prevMetrics];
    }

    // Find best final state (should be 0 after tail bits, but check all)
    let bestState = 0;
    let bestMetric = prevMetrics[0];

    for (let state = 1; state < this.numStates; state++) {
      if (prevMetrics[state] < bestMetric) {
        bestMetric = prevMetrics[state];
        bestState = state;
      }
    }

    // Traceback to recover input bits
    const decodedBits = this.traceback(history, bestState);

    // Remove tail bits and pack into bytes
    const dataBits = decodedBits.slice(0, decodedBits.length - this.memory);
    return this.packBits(dataBits);
  }

  /**
   * Calculate branch metric for soft-decision decoding
   * Uses squared Euclidean distance
   */
  private calculateBranchMetric(
    soft1: number, soft2: number,
    expected1: number, expected2: number
  ): number {
    // Soft values are 0.0-1.0, expected values are 0 or 1
    const diff1 = soft1 - expected1;
    const diff2 = soft2 - expected2;

    // Squared Euclidean distance
    return diff1 * diff1 + diff2 * diff2;
  }

  /**
   * Traceback through history to recover decoded bits
   */
  private traceback(history: Uint8Array[], finalState: number): number[] {
    const bits: number[] = [];
    let state = finalState;

    // Trace back through history
    for (let step = history.length - 1; step >= 0; step--) {
      const prevState = history[step][state];

      // Determine input bit that caused this transition
      const transitions = this.reverseTransitions.get(state)!;
      for (const { prevState: ps, inputBit } of transitions) {
        if (ps === prevState) {
          bits.unshift(inputBit);
          break;
        }
      }

      state = prevState;
    }

    return bits;
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
}

/**
 * Convert 8-bit soft values (0-255) to floating point (0.0-1.0)
 */
export function softToFloat(soft: Uint8Array): number[] {
  const result: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    result.push(soft[i] / 255);
  }
  return result;
}

/**
 * Convert hard bits (0/1) to soft values
 * For testing with hard-decision inputs
 */
export function hardToSoft(bits: number[]): number[] {
  return bits.map(b => b === 1 ? 1.0 : 0.0);
}

/**
 * Unpack bytes into bits
 */
export function unpackBits(bytes: Uint8Array): number[] {
  const bits: number[] = [];

  for (const byte of bytes) {
    for (let i = 7; i >= 0; i--) {
      bits.push((byte >> i) & 1);
    }
  }

  return bits;
}

/**
 * Decode bytes with Viterbi decoder (convenience function)
 *
 * @param encodedBytes - Convolutional-encoded bytes
 * @param originalBitCount - Number of data bits (before encoding)
 * @param isPunctured - Whether puncturing was used
 * @returns Decoded bytes
 */
export function viterbiDecode(
  encodedBytes: Uint8Array,
  originalBitCount: number,
  isPunctured: boolean = true
): Uint8Array {
  const decoder = new ViterbiDecoder();

  // Unpack encoded bytes to bits
  const encodedBits = unpackBits(encodedBytes);

  // Convert to soft values (hard decision as soft)
  const softBits = hardToSoft(encodedBits);

  // Calculate expected output bits for depuncturing
  const tailBits = CONVOLUTIONAL_CONFIG.MEMORY;
  const totalInputBits = originalBitCount + tailBits;
  const expectedOutputBits = totalInputBits * 2; // Rate 1/2 before puncturing

  return decoder.decode(softBits, isPunctured, expectedOutputBits);
}

/**
 * Decode with actual soft-decision input
 */
export function viterbiDecodeSoft(
  softBits: number[],
  originalBitCount: number,
  isPunctured: boolean = true
): Uint8Array {
  const decoder = new ViterbiDecoder();

  const tailBits = CONVOLUTIONAL_CONFIG.MEMORY;
  const totalInputBits = originalBitCount + tailBits;
  const expectedOutputBits = totalInputBits * 2;

  return decoder.decode(softBits, isPunctured, expectedOutputBits);
}
