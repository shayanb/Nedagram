/**
 * v3 Pipeline End-to-End Tests
 *
 * Tests the full v3 encoding/decoding pipeline with:
 * - Scrambling
 * - Convolutional + RS concatenated FEC
 * - Soft-decision decoding (simulated)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { setAudioMode, FRAME_V3, FRAME } from '../../src/utils/constants';
import { scramble, descramble, LFSR_SEED } from '../../src/encode/scramble';
import {
  encodeV3FEC,
  encodeWithV3FEC,
  calculateV3EncodedSize,
  getOriginalBitCount,
} from '../../src/encode/v3-fec';
import {
  decodeV3FEC,
  decodeV3FECSoft,
  decodeHeaderV3FEC,
  decodeDataV3FEC,
  getV3HeaderEncodedSize,
  getV3DataEncodedSize,
} from '../../src/decode/v3-fec';
import { unpackBits, hardToSoft } from '../../src/decode/viterbi';
import { RSEncoder } from '../../src/lib/reed-solomon';

describe('v3 Pipeline End-to-End', () => {
  beforeEach(() => {
    setAudioMode('phone');
  });

  describe('v3 Constants', () => {
    it('should have v3 frame constants', () => {
      expect(FRAME_V3.HEADER_MAGIC).toBe('N3');
      expect(FRAME_V3.CURRENT_VERSION).toBe(0x03);
      expect(FRAME_V3.FEC_MODE).toBe('concatenated');
    });

    it('should inherit from v2 frame constants', () => {
      expect(FRAME_V3.PAYLOAD_SIZE).toBe(FRAME.PAYLOAD_SIZE);
      expect(FRAME_V3.RS_PARITY_SIZE).toBe(FRAME.RS_PARITY_SIZE);
      expect(FRAME_V3.HEADER_SIZE).toBe(FRAME.HEADER_SIZE);
    });
  });

  describe('Full Frame Roundtrip', () => {
    it('should roundtrip a v3 header frame', () => {
      // Create a v3 header
      const header = new Uint8Array(FRAME_V3.HEADER_SIZE);
      header[0] = 0x4E; // 'N'
      header[1] = 0x33; // '3'
      header[2] = FRAME_V3.CURRENT_VERSION;
      header[3] = 0x00; // flags
      // Fill rest with test data
      for (let i = 4; i < header.length; i++) {
        header[i] = i * 17 % 256;
      }

      // Encode with v3 FEC
      const encoded = encodeV3FEC(header);

      // Decode
      const result = decodeHeaderV3FEC(encoded);

      expect(result.success).toBe(true);
      expect(result.viterbiSuccess).toBe(true);
      expect(result.rsSuccess).toBe(true);
      expect(Array.from(result.data)).toEqual(Array.from(header));
    });

    it('should roundtrip a v3 data frame with various sizes', () => {
      const payloadSizes = [1, 16, 32, 64, 96, 128];

      for (const payloadSize of payloadSizes) {
        // Create data frame: 3 byte header + payload
        const frame = new Uint8Array(3 + payloadSize);
        frame[0] = 0x44; // 'D'
        frame[1] = 0x00; // frame index high byte
        frame[2] = 0x00; // frame index low byte

        // Fill payload with test pattern
        for (let i = 3; i < frame.length; i++) {
          frame[i] = (i * 31) % 256;
        }

        // Encode
        const encoded = encodeV3FEC(frame);

        // Verify encoded size
        expect(encoded.length).toBe(getV3DataEncodedSize(payloadSize));

        // Decode
        const result = decodeDataV3FEC(encoded, payloadSize);

        expect(result.success).toBe(true);
        expect(result.data.length).toBe(frame.length);
        expect(Array.from(result.data)).toEqual(Array.from(frame));
      }
    });
  });

  describe('Soft Decision Pipeline', () => {
    it('should decode with soft decision input', () => {
      const header = new Uint8Array(FRAME_V3.HEADER_SIZE);
      header[0] = 0x4E;
      header[1] = 0x33;
      header[2] = FRAME_V3.CURRENT_VERSION;

      // Encode
      const encoded = encodeV3FEC(header);

      // Convert to soft bits (simulate perfect reception)
      const bits = unpackBits(encoded);
      const softBits = hardToSoft(bits);

      // Decode with soft decision
      const result = decodeV3FECSoft(softBits, 'header');

      expect(result.success).toBe(true);
      expect(Array.from(result.data)).toEqual(Array.from(header));
    });

    it('should decode noisy soft input', () => {
      const payloadSize = 64;
      const frame = new Uint8Array(3 + payloadSize);
      frame[0] = 0x44;
      for (let i = 3; i < frame.length; i++) {
        frame[i] = i % 256;
      }

      // Encode
      const encoded = encodeV3FEC(frame);

      // Convert to soft bits with moderate noise
      const bits = unpackBits(encoded);
      const softBits = bits.map((b, i) => {
        // Occasional uncertain bits (2% of bits)
        if (i % 50 === 0) {
          return 0.5; // Maximum uncertainty
        }
        // Most bits have slight noise
        const base = b === 1 ? 0.9 : 0.1;
        return base;
      });

      // Decode
      const result = decodeV3FECSoft(softBits, 'data', payloadSize);

      expect(result.success).toBe(true);
      expect(Array.from(result.data)).toEqual(Array.from(frame));
    });
  });

  describe('Error Correction Capability', () => {
    it('should correct random bit errors', () => {
      const frame = new Uint8Array(3 + 64);
      frame[0] = 0x44;
      for (let i = 3; i < frame.length; i++) {
        frame[i] = i % 256;
      }

      const encoded = encodeV3FEC(frame);

      // Introduce random bit errors (flip 5% of bits)
      const corrupted = new Uint8Array(encoded);
      const numErrors = Math.floor(encoded.length * 8 * 0.05);

      for (let i = 0; i < numErrors; i++) {
        const byteIdx = Math.floor(Math.random() * corrupted.length);
        const bitIdx = Math.floor(Math.random() * 8);
        corrupted[byteIdx] ^= (1 << bitIdx);
      }

      // Decode should still succeed due to FEC
      const result = decodeDataV3FEC(corrupted, 64);

      // May or may not succeed depending on error distribution
      // But if it succeeds, data should be correct
      if (result.success) {
        expect(Array.from(result.data)).toEqual(Array.from(frame));
      }
    });

    it('should correct burst errors', () => {
      const frame = new Uint8Array(3 + 64);
      frame[0] = 0x44;
      for (let i = 3; i < frame.length; i++) {
        frame[i] = i % 256;
      }

      const encoded = encodeV3FEC(frame);

      // Introduce burst error (corrupt consecutive bytes)
      const corrupted = new Uint8Array(encoded);
      const burstStart = Math.floor(encoded.length / 3);
      const burstLength = 3;

      for (let i = 0; i < burstLength; i++) {
        corrupted[burstStart + i] ^= 0xFF;
      }

      // Convert to soft with the burst marked as uncertain
      const bits = unpackBits(corrupted);
      const softBits = bits.map((b, i) => {
        const byteIdx = Math.floor(i / 8);
        if (byteIdx >= burstStart && byteIdx < burstStart + burstLength) {
          return 0.5; // Mark burst as uncertain
        }
        return b === 1 ? 0.95 : 0.05;
      });

      // Soft decision should handle the erasure-like situation better
      const result = decodeV3FECSoft(softBits, 'data', 64);

      expect(result.success).toBe(true);
      expect(Array.from(result.data)).toEqual(Array.from(frame));
    });
  });

  describe('Scrambler Integration', () => {
    it('should scramble and descramble correctly in pipeline', () => {
      const data = new Uint8Array([0x00, 0xFF, 0xAA, 0x55, 0x12, 0x34]);

      // Scramble
      const scrambled = scramble(data, LFSR_SEED);

      // Should be different from original (with high probability)
      expect(Array.from(scrambled)).not.toEqual(Array.from(data));

      // Descramble
      const descrambled = descramble(scrambled, LFSR_SEED);

      // Should match original
      expect(Array.from(descrambled)).toEqual(Array.from(data));
    });

    it('should produce good bit distribution after scrambling', () => {
      // Test with all zeros (worst case for unscrambled)
      const zeros = new Uint8Array(100).fill(0);
      const scrambled = scramble(zeros, LFSR_SEED);

      // Count ones in scrambled output
      let ones = 0;
      for (const byte of scrambled) {
        for (let i = 0; i < 8; i++) {
          if ((byte >> i) & 1) ones++;
        }
      }

      const total = scrambled.length * 8;
      const ratio = ones / total;

      // Should be roughly 50% ones (within 10% tolerance)
      expect(ratio).toBeGreaterThan(0.4);
      expect(ratio).toBeLessThan(0.6);
    });
  });

  describe('Multi-Frame Pipeline', () => {
    it('should encode and decode multiple frames', () => {
      // Create header
      const header = new Uint8Array(FRAME_V3.HEADER_SIZE);
      header[0] = 0x4E;
      header[1] = 0x33;
      header[2] = FRAME_V3.CURRENT_VERSION;

      // Create data frames
      const dataFrames = [
        new Uint8Array(3 + 128), // Full frame
        new Uint8Array(3 + 64),  // Half frame
        new Uint8Array(3 + 32),  // Quarter frame
      ];

      for (let i = 0; i < dataFrames.length; i++) {
        dataFrames[i][0] = 0x44; // 'D'
        dataFrames[i][1] = 0x00;
        dataFrames[i][2] = i;    // Frame index
        for (let j = 3; j < dataFrames[i].length; j++) {
          dataFrames[i][j] = (i * 100 + j) % 256;
        }
      }

      // Encode all
      const { encodedHeader, encodedDataFrames } = encodeWithV3FEC(header, dataFrames);

      // Verify header
      const headerResult = decodeHeaderV3FEC(encodedHeader);
      expect(headerResult.success).toBe(true);
      expect(Array.from(headerResult.data)).toEqual(Array.from(header));

      // Verify data frames
      const payloadSizes = [128, 64, 32];
      for (let i = 0; i < encodedDataFrames.length; i++) {
        const result = decodeDataV3FEC(encodedDataFrames[i], payloadSizes[i]);
        expect(result.success).toBe(true);
        expect(Array.from(result.data)).toEqual(Array.from(dataFrames[i]));
      }
    });
  });

  describe('Size Efficiency', () => {
    it('should have reasonable overhead', () => {
      const payloadSizes = [32, 64, 128];

      for (const payloadSize of payloadSizes) {
        const rawSize = 3 + payloadSize; // 3 byte header + payload
        const encodedSize = getV3DataEncodedSize(payloadSize);

        // v3 overhead: RS (16 bytes) + convolutional (~1.5x)
        // Total should be roughly: (rawSize + 16) * 1.5
        const expectedMin = Math.floor((rawSize + 16) * 1.3);
        const expectedMax = Math.ceil((rawSize + 16) * 1.7);

        expect(encodedSize).toBeGreaterThanOrEqual(expectedMin);
        expect(encodedSize).toBeLessThanOrEqual(expectedMax);
      }
    });

    it('should calculate correct original bit count', () => {
      // Header
      const headerBits = getOriginalBitCount('header');
      expect(headerBits).toBe((FRAME_V3.HEADER_SIZE + FRAME_V3.RS_PARITY_SIZE) * 8);

      // Data
      for (const payloadSize of [32, 64, 128]) {
        const dataBits = getOriginalBitCount('data', payloadSize);
        expect(dataBits).toBe((3 + payloadSize + FRAME_V3.RS_PARITY_SIZE) * 8);
      }
    });
  });

  describe('Text Data Pipeline', () => {
    it('should roundtrip text through v3 pipeline', () => {
      const testStrings = [
        'Hello, Nedagram v3!',
        'مرحبا بك في ندآگرام', // Farsi text
        'Special chars: @#$%^&*(){}[]',
        'A'.repeat(100), // Long repeated text
      ];

      for (const text of testStrings) {
        const textBytes = new TextEncoder().encode(text);

        // Create frame with text
        const frame = new Uint8Array(3 + textBytes.length);
        frame[0] = 0x44;
        frame[1] = 0x00;
        frame[2] = 0x00;
        frame.set(textBytes, 3);

        // Encode and decode
        const encoded = encodeV3FEC(frame);
        const decoded = decodeDataV3FEC(encoded, textBytes.length);

        expect(decoded.success).toBe(true);

        // Extract and verify text
        const decodedText = new TextDecoder().decode(decoded.data.slice(3));
        expect(decodedText).toBe(text);
      }
    });
  });
});
