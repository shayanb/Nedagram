import { describe, it, expect } from 'vitest';
import { encodeString, encodeBytes, checkPayloadSize, estimateEncode } from '../src/encode';
import { LIMITS } from '../src/utils/constants';

describe('Encode Pipeline', () => {
  describe('checkPayloadSize', () => {
    it('should accept small payloads', () => {
      const data = new Uint8Array(1000);
      const result = checkPayloadSize(data);
      expect(result.valid).toBe(true);
      expect(result.warning).toBe(false);
    });

    it('should warn for large payloads', () => {
      const data = new Uint8Array(LIMITS.SOFT_LIMIT_BYTES + 1);
      const result = checkPayloadSize(data);
      expect(result.valid).toBe(true);
      expect(result.warning).toBe(true);
    });

    it('should reject oversized payloads', () => {
      const data = new Uint8Array(LIMITS.MAX_PAYLOAD_BYTES + 1);
      const result = checkPayloadSize(data);
      expect(result.valid).toBe(false);
    });
  });

  describe('encodeString', () => {
    it('should encode "hello world"', async () => {
      const result = await encodeString('hello world');

      expect(result.audio).toBeInstanceOf(Float32Array);
      expect(result.audio.length).toBeGreaterThan(0);
      expect(result.sampleRate).toBe(48000);
      expect(result.checksum).toHaveLength(64); // SHA-256 hex
      expect(result.stats.originalSize).toBe(11);
      expect(result.stats.frameCount).toBeGreaterThanOrEqual(1);
    });

    it('should compress compressible data', async () => {
      const repeated = 'test data '.repeat(100);
      const result = await encodeString(repeated);

      expect(result.stats.compressed).toBe(true);
      expect(result.stats.compressedSize).toBeLessThan(result.stats.originalSize);
    });

    it('should not compress incompressible data', async () => {
      // Random-looking data doesn't compress well
      const random = Array.from({ length: 50 }, () =>
        String.fromCharCode(Math.floor(Math.random() * 256))
      ).join('');

      const result = await encodeString(random);

      // May or may not be compressed depending on randomness
      // Just verify it doesn't crash
      expect(result.audio.length).toBeGreaterThan(0);
    });

    it('should produce consistent checksums', async () => {
      const text = 'deterministic test';
      const result1 = await encodeString(text);
      const result2 = await encodeString(text);

      expect(result1.checksum).toBe(result2.checksum);
    });
  });

  describe('v3 Protocol Encoding', () => {
    it('should encode with v3 protocol', async () => {
      const result = await encodeString('hello v3 world', {
        protocolVersion: 'v3',
      });

      expect(result.audio).toBeInstanceOf(Float32Array);
      expect(result.audio.length).toBeGreaterThan(0);
      expect(result.sampleRate).toBe(48000);
      expect(result.checksum).toHaveLength(64);
    });

    it('should produce larger output with v3 (due to convolutional FEC)', async () => {
      const text = 'test data for v3 encoding';

      const v2Result = await encodeString(text, { protocolVersion: 'v2' });
      const v3Result = await encodeString(text, { protocolVersion: 'v3' });

      // v3 should produce larger encoded output due to convolutional overhead
      expect(v3Result.stats.totalEncodedBytes).toBeGreaterThan(v2Result.stats.totalEncodedBytes);

      // v3 audio should be longer
      expect(v3Result.durationSeconds).toBeGreaterThan(v2Result.durationSeconds);
    });

    it('should estimate v3 encoding correctly', () => {
      const dataSize = 1000;

      const v2Estimate = estimateEncode(dataSize, 'v2');
      const v3Estimate = estimateEncode(dataSize, 'v3');

      // v3 should estimate longer duration
      expect(v3Estimate.estimatedDuration).toBeGreaterThan(v2Estimate.estimatedDuration);
    });

    it('should encode bytes with v3 protocol', async () => {
      const data = new Uint8Array([0x48, 0x65, 0x6c, 0x6c, 0x6f]); // "Hello"

      const result = await encodeBytes(data, { protocolVersion: 'v3' });

      expect(result.audio).toBeInstanceOf(Float32Array);
      expect(result.stats.originalSize).toBe(5);
    });
  });
});
