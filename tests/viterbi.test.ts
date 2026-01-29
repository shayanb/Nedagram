/**
 * Tests for Viterbi Decoder
 */

import { describe, it, expect } from 'vitest';
import {
  ViterbiDecoder,
  viterbiDecode,
  viterbiDecodeSoft,
  hardToSoft,
  softToFloat,
  unpackBits,
} from '../src/decode/viterbi';
import {
  ConvolutionalEncoder,
  convolutionalEncode,
  CONVOLUTIONAL_CONFIG,
} from '../src/encode/convolutional';

describe('Viterbi Decoder', () => {
  describe('Utility Functions', () => {
    describe('unpackBits', () => {
      it('should unpack bytes to bits correctly', () => {
        const bytes = new Uint8Array([0x80]); // 10000000
        const bits = unpackBits(bytes);

        expect(bits.length).toBe(8);
        expect(bits[0]).toBe(1);
        expect(bits[1]).toBe(0);
        expect(bits[7]).toBe(0);
      });

      it('should unpack multiple bytes', () => {
        const bytes = new Uint8Array([0xFF, 0x00]); // 11111111 00000000
        const bits = unpackBits(bytes);

        expect(bits.length).toBe(16);
        expect(bits.slice(0, 8).every(b => b === 1)).toBe(true);
        expect(bits.slice(8, 16).every(b => b === 0)).toBe(true);
      });

      it('should handle 0xAA pattern', () => {
        const bytes = new Uint8Array([0xAA]); // 10101010
        const bits = unpackBits(bytes);

        expect(bits).toEqual([1, 0, 1, 0, 1, 0, 1, 0]);
      });
    });

    describe('hardToSoft', () => {
      it('should convert hard bits to soft values', () => {
        const hard = [0, 1, 0, 1];
        const soft = hardToSoft(hard);

        expect(soft[0]).toBe(0.0);
        expect(soft[1]).toBe(1.0);
        expect(soft[2]).toBe(0.0);
        expect(soft[3]).toBe(1.0);
      });
    });

    describe('softToFloat', () => {
      it('should convert 8-bit soft values to float', () => {
        const soft = new Uint8Array([0, 127, 255]);
        const floats = softToFloat(soft);

        expect(floats[0]).toBeCloseTo(0, 2);
        expect(floats[1]).toBeCloseTo(0.498, 2);
        expect(floats[2]).toBeCloseTo(1, 2);
      });
    });
  });

  describe('ViterbiDecoder', () => {
    it('should decode all zeros correctly', () => {
      // Encode all zeros
      const input = new Uint8Array([0x00, 0x00]);
      const encoded = convolutionalEncode(input, false);

      // Decode
      const decoded = viterbiDecode(encoded, 16, false);

      expect(Array.from(decoded)).toEqual([0x00, 0x00]);
    });

    it('should decode all ones correctly', () => {
      const input = new Uint8Array([0xFF, 0xFF]);
      const encoded = convolutionalEncode(input, false);

      const decoded = viterbiDecode(encoded, 16, false);

      expect(Array.from(decoded)).toEqual([0xFF, 0xFF]);
    });

    it('should decode alternating pattern', () => {
      const input = new Uint8Array([0xAA, 0x55]); // 10101010 01010101
      const encoded = convolutionalEncode(input, false);

      const decoded = viterbiDecode(encoded, 16, false);

      expect(Array.from(decoded)).toEqual([0xAA, 0x55]);
    });

    it('should decode random data', () => {
      const input = new Uint8Array([0x12, 0x34, 0x56, 0x78]);
      const encoded = convolutionalEncode(input, false);

      const decoded = viterbiDecode(encoded, 32, false);

      expect(Array.from(decoded)).toEqual([0x12, 0x34, 0x56, 0x78]);
    });

    it('should decode longer messages', () => {
      const input = new Uint8Array([
        0x48, 0x65, 0x6C, 0x6C, 0x6F, // "Hello"
      ]);
      const encoded = convolutionalEncode(input, false);

      const decoded = viterbiDecode(encoded, 40, false);

      expect(Array.from(decoded)).toEqual([0x48, 0x65, 0x6C, 0x6C, 0x6F]);
    });
  });

  describe('Punctured Encoding/Decoding', () => {
    it('should decode punctured all zeros', () => {
      const input = new Uint8Array([0x00, 0x00]);
      const encoded = convolutionalEncode(input, true); // Punctured

      const decoded = viterbiDecode(encoded, 16, true);

      expect(Array.from(decoded)).toEqual([0x00, 0x00]);
    });

    it('should decode punctured all ones', () => {
      const input = new Uint8Array([0xFF, 0xFF]);
      const encoded = convolutionalEncode(input, true);

      const decoded = viterbiDecode(encoded, 16, true);

      expect(Array.from(decoded)).toEqual([0xFF, 0xFF]);
    });

    it('should decode punctured random data', () => {
      const input = new Uint8Array([0xAB, 0xCD, 0xEF]);
      const encoded = convolutionalEncode(input, true);

      const decoded = viterbiDecode(encoded, 24, true);

      expect(Array.from(decoded)).toEqual([0xAB, 0xCD, 0xEF]);
    });

    it('should decode punctured longer message', () => {
      const input = new Uint8Array([
        0x54, 0x65, 0x73, 0x74, 0x21, // "Test!"
      ]);
      const encoded = convolutionalEncode(input, true);

      const decoded = viterbiDecode(encoded, 40, true);

      expect(Array.from(decoded)).toEqual([0x54, 0x65, 0x73, 0x74, 0x21]);
    });

    it('should handle punctured encoding with reduced size', () => {
      const input = new Uint8Array([0x12, 0x34, 0x56, 0x78]);

      const encodedUnpunctured = convolutionalEncode(input, false);
      const encodedPunctured = convolutionalEncode(input, true);

      // Punctured should be smaller
      expect(encodedPunctured.length).toBeLessThan(encodedUnpunctured.length);
    });
  });

  describe('Soft-Decision Decoding', () => {
    it('should decode with soft input values', () => {
      const input = new Uint8Array([0xAA]);
      const encoded = convolutionalEncode(input, false);

      // Convert to soft bits
      const bits = unpackBits(encoded);
      const softBits = hardToSoft(bits);

      const decoded = viterbiDecodeSoft(softBits, 8, false);

      expect(Array.from(decoded)).toEqual([0xAA]);
    });

    it('should decode with slightly noisy soft values', () => {
      const input = new Uint8Array([0x42]);
      const encoded = convolutionalEncode(input, false);

      // Convert to soft bits and add small noise
      const bits = unpackBits(encoded);
      const softBits = bits.map(b => {
        const base = b === 1 ? 0.95 : 0.05; // Slightly noisy
        return base;
      });

      const decoded = viterbiDecodeSoft(softBits, 8, false);

      expect(Array.from(decoded)).toEqual([0x42]);
    });

    it('should handle uncertain bits gracefully', () => {
      const input = new Uint8Array([0x00, 0x00]);
      const encoded = convolutionalEncode(input, false);

      // Convert to soft bits, but make some uncertain
      const bits = unpackBits(encoded);
      const softBits = bits.map((b, i) => {
        if (i % 5 === 0) return 0.5; // Every 5th bit is uncertain
        return b === 1 ? 1.0 : 0.0;
      });

      const decoded = viterbiDecodeSoft(softBits, 16, false);

      // Should still decode correctly due to FEC
      expect(Array.from(decoded)).toEqual([0x00, 0x00]);
    });
  });

  describe('Error Correction', () => {
    it('should correct single bit error', () => {
      const input = new Uint8Array([0x00, 0x00]);
      const encoded = convolutionalEncode(input, false);

      // Introduce a single bit error
      const bits = unpackBits(encoded);
      bits[5] = 1 - bits[5]; // Flip one bit
      const softBits = hardToSoft(bits);

      const decoded = viterbiDecodeSoft(softBits, 16, false);

      expect(Array.from(decoded)).toEqual([0x00, 0x00]);
    });

    it('should correct multiple spread-out errors', () => {
      const input = new Uint8Array([0xFF]);
      const encoded = convolutionalEncode(input, false);

      // Introduce errors at spread positions
      const bits = unpackBits(encoded);
      bits[2] = 1 - bits[2];
      bits[10] = 1 - bits[10];
      const softBits = hardToSoft(bits);

      const decoded = viterbiDecodeSoft(softBits, 8, false);

      expect(Array.from(decoded)).toEqual([0xFF]);
    });

    it('should handle soft errors better than hard errors', () => {
      const input = new Uint8Array([0xAA]);
      const encoded = convolutionalEncode(input, false);

      // Create "weak" errors (soft values near 0.5)
      const bits = unpackBits(encoded);
      const softBits = bits.map((b, i) => {
        if (i === 3 || i === 7) {
          // These bits are "uncertain"
          return 0.5;
        }
        return b === 1 ? 0.9 : 0.1;
      });

      const decoded = viterbiDecodeSoft(softBits, 8, false);

      // Decoder should use uncertain bits' info
      expect(Array.from(decoded)).toEqual([0xAA]);
    });
  });

  describe('Roundtrip Tests', () => {
    it('should roundtrip single byte', () => {
      for (let byte = 0; byte < 256; byte += 17) { // Test subset
        const input = new Uint8Array([byte]);
        const encoded = convolutionalEncode(input, false);
        const decoded = viterbiDecode(encoded, 8, false);

        expect(Array.from(decoded)).toEqual([byte]);
      }
    });

    it('should roundtrip various lengths', () => {
      const lengths = [1, 2, 4, 8, 16];

      for (const len of lengths) {
        const input = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          input[i] = (i * 17 + 42) % 256;
        }

        const encoded = convolutionalEncode(input, false);
        const decoded = viterbiDecode(encoded, len * 8, false);

        expect(Array.from(decoded)).toEqual(Array.from(input));
      }
    });

    it('should roundtrip with puncturing', () => {
      const testData = [
        [0x00],
        [0xFF],
        [0xAA, 0x55],
        [0x12, 0x34, 0x56],
        [0xDE, 0xAD, 0xBE, 0xEF],
      ];

      for (const data of testData) {
        const input = new Uint8Array(data);
        const encoded = convolutionalEncode(input, true);
        const decoded = viterbiDecode(encoded, data.length * 8, true);

        expect(Array.from(decoded)).toEqual(data);
      }
    });

    it('should roundtrip text data', () => {
      const text = 'Hello, World!';
      const input = new TextEncoder().encode(text);

      const encoded = convolutionalEncode(input, true);
      const decoded = viterbiDecode(encoded, input.length * 8, true);

      const decodedText = new TextDecoder().decode(decoded);
      expect(decodedText).toBe(text);
    });
  });

  describe('Edge Cases', () => {
    it('should handle minimum input (empty data, just tail)', () => {
      const input = new Uint8Array(0);
      const encoded = convolutionalEncode(input, false);
      const decoded = viterbiDecode(encoded, 0, false);

      expect(decoded.length).toBe(0);
    });

    it('should handle odd-length soft input', () => {
      // Manually create odd-length soft bits
      const softBits = [0.0, 1.0, 0.0]; // Odd length

      // Should not throw, will pad internally
      expect(() => {
        const decoder = new ViterbiDecoder();
        decoder.decode(softBits, false);
      }).not.toThrow();
    });
  });

  describe('Performance Characteristics', () => {
    it('should complete in reasonable time for typical message', () => {
      const input = new Uint8Array(100); // 100 bytes = typical VPN config snippet
      for (let i = 0; i < 100; i++) {
        input[i] = i % 256;
      }

      const start = performance.now();

      const encoded = convolutionalEncode(input, true);
      const decoded = viterbiDecode(encoded, 800, true);

      const elapsed = performance.now() - start;

      // Should complete in under 100ms
      expect(elapsed).toBeLessThan(100);
      expect(Array.from(decoded)).toEqual(Array.from(input));
    });
  });
});
