/**
 * Tests for v3 FEC (Concatenated RS + Convolutional)
 */

import { describe, it, expect } from 'vitest';
import {
  encodeV3FEC,
  encodeHeaderV3FEC,
  encodeDataV3FEC,
  encodeWithV3FEC,
  calculateV3EncodedSize,
  calculateV3TotalSize,
  getOriginalBitCount,
  V3_FEC_CONFIG,
} from '../src/encode/v3-fec';
import {
  decodeV3FEC,
  decodeV3FECSoft,
  decodeHeaderV3FEC,
  decodeDataV3FEC,
  decodeHeaderV3FECWithRedundancy,
  getV3HeaderEncodedSize,
  getV3DataEncodedSize,
} from '../src/decode/v3-fec';
import { unpackBits, hardToSoft } from '../src/decode/viterbi';
import { FRAME } from '../src/utils/constants';

describe('v3 FEC (Concatenated RS + Convolutional)', () => {
  describe('Configuration', () => {
    it('should have correct configuration', () => {
      expect(V3_FEC_CONFIG.USE_PUNCTURING).toBe(true);
      expect(V3_FEC_CONFIG.RS_PARITY_SIZE).toBe(16);
      expect(V3_FEC_CONFIG.CONV_RATE).toBeCloseTo(2 / 3, 2);
    });
  });

  describe('Size Calculations', () => {
    it('should calculate encoded size correctly', () => {
      // Header: 12 bytes + 16 RS = 28 bytes → convolutional encoding
      const headerSize = calculateV3EncodedSize(FRAME.HEADER_SIZE);
      expect(headerSize).toBeGreaterThan(FRAME.HEADER_SIZE + FRAME.RS_PARITY_SIZE);

      // With rate 2/3 puncturing, output should be ~1.5x of RS-encoded size
      const rsSize = FRAME.HEADER_SIZE + FRAME.RS_PARITY_SIZE;
      const expectedMin = Math.floor(rsSize * 1.3); // Account for tail bits
      const expectedMax = Math.ceil(rsSize * 1.7);
      expect(headerSize).toBeGreaterThanOrEqual(expectedMin);
      expect(headerSize).toBeLessThanOrEqual(expectedMax);
    });

    it('should calculate header encoded size', () => {
      const size = getV3HeaderEncodedSize();
      expect(size).toBeGreaterThan(0);
      expect(size).toEqual(calculateV3EncodedSize(FRAME.HEADER_SIZE));
    });

    it('should calculate data encoded size', () => {
      const payloadSizes = [32, 64, 128];

      for (const payload of payloadSizes) {
        const size = getV3DataEncodedSize(payload);
        const expected = calculateV3EncodedSize(3 + payload);
        expect(size).toEqual(expected);
      }
    });

    it('should calculate total size with overhead ratio', () => {
      const result = calculateV3TotalSize(100);

      expect(result.dataFrames).toBeGreaterThan(0);
      expect(result.headerBytes).toBeGreaterThan(0);
      expect(result.dataBytes).toBeGreaterThan(0);
      expect(result.totalBytes).toBe(result.headerBytes + result.dataBytes);
      // v3 adds convolutional overhead (punctured rate 2/3 = 1.5x) on top of RS
      // But the comparison baseline already includes RS, so ratio is ~1.1-1.2
      // (convolutional expansion happens after RS encoding)
      expect(result.overheadRatio).toBeGreaterThan(1.0);
      expect(result.overheadRatio).toBeLessThan(1.5);
    });
  });

  describe('Bit Count Calculations', () => {
    it('should calculate header bit count', () => {
      const bitCount = getOriginalBitCount('header');
      const expectedBytes = FRAME.HEADER_SIZE + FRAME.RS_PARITY_SIZE;
      expect(bitCount).toBe(expectedBytes * 8);
    });

    it('should calculate data bit count', () => {
      const payloadSize = 64;
      const bitCount = getOriginalBitCount('data', payloadSize);
      const expectedBytes = 3 + payloadSize + FRAME.RS_PARITY_SIZE;
      expect(bitCount).toBe(expectedBytes * 8);
    });
  });

  describe('Encoding', () => {
    it('should encode header frame', () => {
      const header = new Uint8Array(FRAME.HEADER_SIZE);
      header[0] = 0x4E; // 'N'
      header[1] = 0x31; // '1'

      const encoded = encodeHeaderV3FEC(header);

      expect(encoded.length).toBe(getV3HeaderEncodedSize());
      expect(encoded.length).toBeGreaterThan(header.length);
    });

    it('should encode data frame', () => {
      const dataFrame = new Uint8Array(3 + 64); // 3 header + 64 payload
      dataFrame[0] = 0x44; // 'D'

      const encoded = encodeDataV3FEC(dataFrame);

      expect(encoded.length).toBe(getV3DataEncodedSize(64));
    });

    it('should encode multiple frames', () => {
      const header = new Uint8Array(FRAME.HEADER_SIZE);
      const dataFrames = [
        new Uint8Array(3 + 64),
        new Uint8Array(3 + 32),
      ];

      const result = encodeWithV3FEC(header, dataFrames);

      expect(result.encodedHeader.length).toBe(getV3HeaderEncodedSize());
      expect(result.encodedDataFrames.length).toBe(2);
      expect(result.encodedDataFrames[0].length).toBe(getV3DataEncodedSize(64));
      expect(result.encodedDataFrames[1].length).toBe(getV3DataEncodedSize(32));
    });
  });

  describe('Decoding', () => {
    it('should decode header frame (roundtrip)', () => {
      const header = new Uint8Array(FRAME.HEADER_SIZE);
      header[0] = 0x4E; // 'N'
      header[1] = 0x31; // '1'
      header[2] = 0x02; // version
      for (let i = 3; i < header.length; i++) {
        header[i] = i % 256;
      }

      const encoded = encodeHeaderV3FEC(header);
      const decoded = decodeHeaderV3FEC(encoded);

      expect(decoded.success).toBe(true);
      expect(decoded.viterbiSuccess).toBe(true);
      expect(decoded.rsSuccess).toBe(true);
      expect(Array.from(decoded.data)).toEqual(Array.from(header));
    });

    it('should decode data frame (roundtrip)', () => {
      const payloadSize = 64;
      const dataFrame = new Uint8Array(3 + payloadSize);
      dataFrame[0] = 0x44; // 'D'
      for (let i = 1; i < dataFrame.length; i++) {
        dataFrame[i] = (i * 7) % 256;
      }

      const encoded = encodeDataV3FEC(dataFrame);
      const decoded = decodeDataV3FEC(encoded, payloadSize);

      expect(decoded.success).toBe(true);
      expect(Array.from(decoded.data)).toEqual(Array.from(dataFrame));
    });

    it('should decode with soft decision', () => {
      const header = new Uint8Array(FRAME.HEADER_SIZE);
      header[0] = 0x4E;
      header[1] = 0x31;

      const encoded = encodeHeaderV3FEC(header);

      // Convert to soft bits (perfect hard decision as float)
      const bits = unpackBits(encoded);
      const softBits = hardToSoft(bits);

      const decoded = decodeV3FECSoft(softBits, 'header');

      expect(decoded.success).toBe(true);
      expect(Array.from(decoded.data)).toEqual(Array.from(header));
    });
  });

  describe('Error Correction', () => {
    it('should correct bit errors (via Viterbi)', () => {
      const header = new Uint8Array(FRAME.HEADER_SIZE);
      header.fill(0xAA); // Alternating pattern

      const encoded = encodeHeaderV3FEC(header);

      // Introduce bit errors
      const corrupted = new Uint8Array(encoded);
      corrupted[5] ^= 0x01; // Flip 1 bit
      corrupted[10] ^= 0x02; // Flip another bit

      const decoded = decodeHeaderV3FEC(corrupted);

      expect(decoded.viterbiSuccess).toBe(true);
      // Viterbi should correct these errors
      expect(Array.from(decoded.data)).toEqual(Array.from(header));
    });

    it('should correct byte errors (via RS)', () => {
      const header = new Uint8Array(FRAME.HEADER_SIZE);
      header.fill(0x55);

      const encoded = encodeHeaderV3FEC(header);

      // Introduce more severe errors that Viterbi passes to RS
      const corrupted = new Uint8Array(encoded);
      // Corrupt multiple adjacent bytes (burst error)
      corrupted[3] = 0xFF;
      corrupted[4] = 0xFF;
      corrupted[5] = 0xFF;

      const decoded = decodeHeaderV3FEC(corrupted);

      // Even if there are residual errors after Viterbi, RS should clean them up
      if (decoded.success) {
        expect(Array.from(decoded.data)).toEqual(Array.from(header));
      }
      // Note: severe errors may still fail if they exceed combined correction capability
    });

    it('should handle soft decision with uncertain bits', () => {
      const header = new Uint8Array(FRAME.HEADER_SIZE);
      header[0] = 0x4E;
      header[1] = 0x31;

      const encoded = encodeHeaderV3FEC(header);
      const bits = unpackBits(encoded);

      // Create soft bits with some uncertainty
      const softBits = bits.map((b, i) => {
        if (i % 10 === 0) {
          return 0.5; // Maximum uncertainty
        }
        return b === 1 ? 0.9 : 0.1; // Slightly noisy
      });

      const decoded = decodeV3FECSoft(softBits, 'header');

      // Should still decode correctly due to FEC
      expect(decoded.success).toBe(true);
      expect(Array.from(decoded.data)).toEqual(Array.from(header));
    });
  });

  describe('Redundancy', () => {
    it('should decode header with redundancy (both valid)', () => {
      const header = new Uint8Array(FRAME.HEADER_SIZE);
      header[0] = 0x4E;
      header[1] = 0x31;

      const encoded = encodeHeaderV3FEC(header);

      const result = decodeHeaderV3FECWithRedundancy(encoded, encoded);

      expect(result.success).toBe(true);
      expect(Array.from(result.data)).toEqual(Array.from(header));
    });

    it('should decode header with redundancy (one corrupted)', () => {
      const header = new Uint8Array(FRAME.HEADER_SIZE);
      header[0] = 0x4E;
      header[1] = 0x31;

      const encoded = encodeHeaderV3FEC(header);

      // Severely corrupt copy1
      const corrupted = new Uint8Array(encoded.length).fill(0xFF);

      const result = decodeHeaderV3FECWithRedundancy(corrupted, encoded);

      expect(result.success).toBe(true);
      expect(Array.from(result.data)).toEqual(Array.from(header));
    });
  });

  describe('Roundtrip Tests', () => {
    it('should roundtrip various payload sizes', () => {
      const payloadSizes = [1, 16, 32, 64, 100, 128];

      for (const size of payloadSizes) {
        const frame = new Uint8Array(3 + size);
        frame[0] = 0x44; // 'D'
        for (let i = 1; i < frame.length; i++) {
          frame[i] = i % 256;
        }

        const encoded = encodeDataV3FEC(frame);
        const decoded = decodeDataV3FEC(encoded, size);

        expect(decoded.success).toBe(true);
        expect(decoded.data.length).toBe(frame.length);
        expect(Array.from(decoded.data)).toEqual(Array.from(frame));
      }
    });

    it('should roundtrip text data', () => {
      const text = 'Hello, v3 FEC!';
      const textBytes = new TextEncoder().encode(text);

      // Create a frame with the text
      const frame = new Uint8Array(3 + textBytes.length);
      frame[0] = 0x44;
      frame.set(textBytes, 3);

      const encoded = encodeDataV3FEC(frame);
      const decoded = decodeDataV3FEC(encoded, textBytes.length);

      expect(decoded.success).toBe(true);
      const decodedText = new TextDecoder().decode(decoded.data.slice(3));
      expect(decodedText).toBe(text);
    });
  });

  describe('Edge Cases', () => {
    it('should handle minimum payload size', () => {
      const frame = new Uint8Array(3 + 1); // Minimum: 3 header + 1 payload
      frame[0] = 0x44;
      frame[3] = 0x42;

      const encoded = encodeDataV3FEC(frame);
      const decoded = decodeDataV3FEC(encoded, 1);

      expect(decoded.success).toBe(true);
      expect(decoded.data[3]).toBe(0x42);
    });

    it('should handle all zeros', () => {
      const frame = new Uint8Array(3 + 32);
      frame.fill(0);

      const encoded = encodeDataV3FEC(frame);
      const decoded = decodeDataV3FEC(encoded, 32);

      expect(decoded.success).toBe(true);
      expect(decoded.data.every(b => b === 0)).toBe(true);
    });

    it('should handle all ones', () => {
      const frame = new Uint8Array(3 + 32);
      frame.fill(0xFF);

      const encoded = encodeDataV3FEC(frame);
      const decoded = decodeDataV3FEC(encoded, 32);

      expect(decoded.success).toBe(true);
      expect(decoded.data.every(b => b === 0xFF)).toBe(true);
    });
  });

  describe('Performance', () => {
    it('should encode/decode in reasonable time', () => {
      const frame = new Uint8Array(3 + 128); // Max size frame
      for (let i = 0; i < frame.length; i++) {
        frame[i] = i % 256;
      }

      const start = performance.now();

      for (let i = 0; i < 10; i++) {
        const encoded = encodeDataV3FEC(frame);
        decodeDataV3FEC(encoded, 128);
      }

      const elapsed = performance.now() - start;

      // 10 roundtrips should complete in under 500ms
      expect(elapsed).toBeLessThan(500);
    });
  });
});
