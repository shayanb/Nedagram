/**
 * Tests for Convolutional Encoder
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  ConvolutionalEncoder,
  convolutionalEncode,
  buildStateTransitionTable,
  buildReverseTransitionTable,
  getDepunctureMap,
  depunctureSoft,
  CONVOLUTIONAL_CONFIG,
} from '../src/encode/convolutional';

describe('Convolutional Encoder', () => {
  describe('CONVOLUTIONAL_CONFIG', () => {
    it('should have correct parameters', () => {
      expect(CONVOLUTIONAL_CONFIG.K).toBe(7);
      expect(CONVOLUTIONAL_CONFIG.MEMORY).toBe(6);
      expect(CONVOLUTIONAL_CONFIG.G1).toBe(0x6D); // 109 decimal
      expect(CONVOLUTIONAL_CONFIG.G2).toBe(0x4F); // 79 decimal
      expect(CONVOLUTIONAL_CONFIG.NUM_STATES).toBe(64);
      expect(CONVOLUTIONAL_CONFIG.PUNCTURE_PATTERN).toEqual([1, 1, 0, 1, 1, 0]);
    });
  });

  describe('ConvolutionalEncoder', () => {
    let encoder: ConvolutionalEncoder;

    beforeEach(() => {
      encoder = new ConvolutionalEncoder(false); // No puncturing for basic tests
    });

    it('should start in state 0', () => {
      expect(encoder.getState()).toBe(0);
    });

    it('should reset to state 0', () => {
      // Encode some bits to change state
      encoder.encodeBit(1);
      encoder.encodeBit(1);
      expect(encoder.getState()).not.toBe(0);

      encoder.reset();
      expect(encoder.getState()).toBe(0);
    });

    it('should produce 2 output bits per input bit (rate 1/2)', () => {
      const output = encoder.encodeBit(1);
      expect(output.length).toBe(2);
    });

    it('should encode known test vector (all zeros)', () => {
      // All zeros input should produce all zeros output (from state 0)
      const input = new Uint8Array([0x00]);
      const output = convolutionalEncode(input, false);

      // 8 data bits + 6 tail bits = 14 input bits
      // 14 * 2 = 28 output bits = 4 bytes (rounded up, but last bits may be padding)
      expect(output.length).toBe(4); // ceil(28/8) = 4

      // All zeros should produce all zeros
      expect(output[0]).toBe(0);
      expect(output[1]).toBe(0);
      expect(output[2]).toBe(0);
    });

    it('should encode known test vector (single 1 bit)', () => {
      // Input: 0x80 = 10000000 binary
      // First bit is 1, rest are 0
      const input = new Uint8Array([0x80]);
      const output = convolutionalEncode(input, false);

      // The first input bit (1) with state 0 should produce known outputs
      // Using G1=0x6D (1101101) and G2=0x4F (1001111):
      // fullState = (1 << 6) | 0 = 64
      // out1 = parity(64 & 0x6D) = parity(64) = 1
      // out2 = parity(64 & 0x4F) = parity(64) = 1
      // First two output bits should be [1, 1]
      expect((output[0] >> 6) & 0x3).toBe(0x3); // First two bits are 11
    });

    it('should produce deterministic output', () => {
      const input = new Uint8Array([0xAB, 0xCD]);

      encoder.reset();
      const output1 = encoder.encodeBytes(input);

      encoder.reset();
      const output2 = encoder.encodeBytes(input);

      expect(Array.from(output1)).toEqual(Array.from(output2));
    });

    it('should handle multi-byte input', () => {
      const input = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
      const output = convolutionalEncode(input, false);

      // 32 data bits + 6 tail bits = 38 input bits
      // 38 * 2 = 76 output bits = 10 bytes
      expect(output.length).toBe(10);
    });
  });

  describe('Puncturing', () => {
    let encoder: ConvolutionalEncoder;

    beforeEach(() => {
      encoder = new ConvolutionalEncoder(true); // With puncturing
    });

    it('should reduce output size with puncturing', () => {
      const input = new Uint8Array([0x00, 0x00, 0x00]); // 24 data bits

      const encoderNoPuncture = new ConvolutionalEncoder(false);
      const outputNoPuncture = encoderNoPuncture.encodeBytes(input);

      const outputPunctured = encoder.encodeBytes(input);

      // Punctured output should be smaller
      expect(outputPunctured.length).toBeLessThan(outputNoPuncture.length);
    });

    it('should produce correct punctured rate', () => {
      // With pattern [1,1,0,1,1,0], we keep 4 of 6 bits
      // Rate goes from 1/2 to 2/3
      const input = new Uint8Array([0x00, 0x00, 0x00, 0x00, 0x00, 0x00]); // 48 bits

      const outputPunctured = encoder.encodeBytes(input);
      const unpuncturedSize = ConvolutionalEncoder.calculateOutputSize(6, false);
      const puncturedSize = ConvolutionalEncoder.calculateOutputSize(6, true);

      // Punctured should be approximately 2/3 of unpunctured
      const ratio = puncturedSize / unpuncturedSize;
      expect(ratio).toBeCloseTo(2 / 3, 1);
    });

    it('should calculate output size correctly', () => {
      // 10 bytes input = 80 bits
      // + 6 tail bits = 86 bits
      // Unpunctured: 86 * 2 = 172 bits = 22 bytes
      // Punctured: ceil(86 * 4/3) = 115 bits ≈ 15 bytes
      const unpuncturedSize = ConvolutionalEncoder.calculateOutputSize(10, false);
      const puncturedSize = ConvolutionalEncoder.calculateOutputSize(10, true);

      expect(unpuncturedSize).toBe(22);
      expect(puncturedSize).toBeLessThan(unpuncturedSize);
    });
  });

  describe('State Transition Table', () => {
    it('should have entries for all states', () => {
      const table = buildStateTransitionTable();
      expect(table.size).toBe(64);
    });

    it('should have 2 transitions per state (input 0 and 1)', () => {
      const table = buildStateTransitionTable();

      for (let state = 0; state < 64; state++) {
        const transitions = table.get(state)!;
        expect(transitions.size).toBe(2);
        expect(transitions.has(0)).toBe(true);
        expect(transitions.has(1)).toBe(true);
      }
    });

    it('should have valid next states', () => {
      const table = buildStateTransitionTable();

      for (let state = 0; state < 64; state++) {
        const transitions = table.get(state)!;

        for (const [inputBit, { nextState }] of transitions) {
          expect(nextState).toBeGreaterThanOrEqual(0);
          expect(nextState).toBeLessThan(64);
        }
      }
    });

    it('should have binary outputs (0 or 1)', () => {
      const table = buildStateTransitionTable();

      for (let state = 0; state < 64; state++) {
        const transitions = table.get(state)!;

        for (const [, { outputs }] of transitions) {
          expect(outputs[0]).toBeGreaterThanOrEqual(0);
          expect(outputs[0]).toBeLessThanOrEqual(1);
          expect(outputs[1]).toBeGreaterThanOrEqual(0);
          expect(outputs[1]).toBeLessThanOrEqual(1);
        }
      }
    });

    it('should compute correct next state', () => {
      const table = buildStateTransitionTable();

      // State 0, input 0 -> state 0
      expect(table.get(0)!.get(0)!.nextState).toBe(0);

      // State 0, input 1 -> state 1
      expect(table.get(0)!.get(1)!.nextState).toBe(1);

      // State 1, input 0 -> state 2
      expect(table.get(1)!.get(0)!.nextState).toBe(2);

      // State 1, input 1 -> state 3
      expect(table.get(1)!.get(1)!.nextState).toBe(3);
    });
  });

  describe('Reverse Transition Table', () => {
    it('should have entries for all states', () => {
      const table = buildReverseTransitionTable();
      expect(table.size).toBe(64);
    });

    it('should have 2 predecessors per state', () => {
      const table = buildReverseTransitionTable();

      for (let state = 0; state < 64; state++) {
        const prevs = table.get(state)!;
        expect(prevs.length).toBe(2);
      }
    });

    it('should be consistent with forward table', () => {
      const forward = buildStateTransitionTable();
      const reverse = buildReverseTransitionTable();

      for (let state = 0; state < 64; state++) {
        const prevs = reverse.get(state)!;

        for (const { prevState, inputBit } of prevs) {
          const forwardNext = forward.get(prevState)!.get(inputBit)!.nextState;
          expect(forwardNext).toBe(state);
        }
      }
    });
  });

  describe('Depuncturing', () => {
    it('should create correct depuncture map', () => {
      // Pattern [1,1,0,1,1,0] keeps positions 0,1,3,4 of each 6-bit group
      const map = getDepunctureMap(8);

      // First 8 punctured bits map to original positions
      expect(map[0]).toBe(0);
      expect(map[1]).toBe(1);
      expect(map[2]).toBe(3);
      expect(map[3]).toBe(4);
      expect(map[4]).toBe(6);
      expect(map[5]).toBe(7);
      expect(map[6]).toBe(9);
      expect(map[7]).toBe(10);
    });

    it('should depuncture soft values correctly', () => {
      // 4 soft values corresponding to kept positions
      const punctured = [0.9, 0.1, 0.8, 0.2];

      // Depuncture to 6 positions (one pattern cycle)
      const depunctured = depunctureSoft(punctured, 6);

      expect(depunctured.length).toBe(6);
      expect(depunctured[0]).toBe(0.9); // Kept
      expect(depunctured[1]).toBe(0.1); // Kept
      expect(depunctured[2]).toBe(0.5); // Punctured - erasure
      expect(depunctured[3]).toBe(0.8); // Kept
      expect(depunctured[4]).toBe(0.2); // Kept
      expect(depunctured[5]).toBe(0.5); // Punctured - erasure
    });

    it('should insert erasures (0.5) at punctured positions', () => {
      const punctured = [1.0, 1.0, 1.0, 1.0];
      const depunctured = depunctureSoft(punctured, 6);

      // Positions 2 and 5 should be erasures
      expect(depunctured[2]).toBe(0.5);
      expect(depunctured[5]).toBe(0.5);
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty input', () => {
      const input = new Uint8Array(0);
      const output = convolutionalEncode(input, false);

      // Still outputs tail bits
      // 0 data bits + 6 tail bits = 6 bits
      // 6 * 2 = 12 output bits = 2 bytes
      expect(output.length).toBe(2);
    });

    it('should handle single byte', () => {
      const input = new Uint8Array([0xFF]);
      const output = convolutionalEncode(input, false);

      // 8 data bits + 6 tail bits = 14 bits
      // 14 * 2 = 28 output bits = 4 bytes
      expect(output.length).toBe(4);
    });

    it('should handle all ones input', () => {
      const input = new Uint8Array([0xFF, 0xFF, 0xFF, 0xFF]);
      const output = convolutionalEncode(input, false);

      // Should produce valid output without errors
      expect(output.length).toBeGreaterThan(0);
    });
  });
});
