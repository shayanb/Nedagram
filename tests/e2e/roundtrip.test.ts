import { describe, it, expect } from 'vitest';
import { encodeString } from '../../src/encode';
import { tryCompress, decompress } from '../../src/encode/compress';
import { packetize, createHeaderFrame, createDataFrame } from '../../src/encode/frame';
import { parseHeaderFrame, parseDataFrame, FrameCollector } from '../../src/decode/deframe';
import { addFEC } from '../../src/encode/fec';
import { decodeFEC } from '../../src/decode/fec';
import { stringToBytes, bytesToString } from '../../src/utils/helpers';

describe('End-to-End Roundtrip', () => {
  describe('Compression roundtrip', () => {
    it('should compress and decompress text', () => {
      const original = 'Hello, world! '.repeat(100);
      const bytes = stringToBytes(original);

      const { data: compressed, compressed: wasCompressed } = tryCompress(bytes);
      expect(wasCompressed).toBe(true);
      expect(compressed.length).toBeLessThan(bytes.length);

      const decompressed = decompress(compressed);
      expect(bytesToString(decompressed)).toBe(original);
    });
  });

  describe('Frame roundtrip', () => {
    it('should create and parse header frame', () => {
      const { frame, sessionId } = createHeaderFrame(
        5,      // totalFrames
        1024,   // payloadLength (max 65535 for compact format)
        2048,   // originalLength (max 65535 for compact format)
        true    // compressed
      );

      const parsed = parseHeaderFrame(frame);

      expect(parsed).not.toBeNull();
      expect(parsed!.magic).toBe('N1'); // Compact format uses N1
      expect(parsed!.totalFrames).toBe(5);
      expect(parsed!.payloadLength).toBe(1024);
      expect(parsed!.originalLength).toBe(2048);
      expect(parsed!.compressed).toBe(true);
      expect(parsed!.sessionId).toBe(sessionId);
      expect(parsed!.crcValid).toBe(true);
    });

    it('should create and parse data frame', () => {
      const sessionId = 0x1234; // 16-bit in compact format
      const payload = new Uint8Array(128);
      for (let i = 0; i < payload.length; i++) payload[i] = i;

      const frame = createDataFrame(sessionId, 1, payload);
      const parsed = parseDataFrame(frame);

      expect(parsed).not.toBeNull();
      expect(parsed!.magic).toBe('D'); // Compact format uses D
      expect(parsed!.frameIndex).toBe(1);
      expect(parsed!.payloadLength).toBe(128);
      expect(parsed!.payload).toEqual(payload);
      expect(parsed!.crcValid).toBe(true); // RS handles errors, always true
    });
  });

  describe('FEC roundtrip', () => {
    it('should encode and decode with FEC (no errors)', () => {
      const data = new Uint8Array(128);
      for (let i = 0; i < data.length; i++) data[i] = i * 2;

      const encoded = addFEC(data);
      expect(encoded.length).toBe(144); // 128 + 16 parity (compact format)

      const { data: decoded, success, correctedErrors } = decodeFEC(encoded);

      expect(success).toBe(true);
      expect(decoded).toEqual(data);
      expect(correctedErrors).toBe(0);
    });

    // Error correction - with 16 parity bytes, can correct up to 8 errors
    it('should correct errors', () => {
      const data = new Uint8Array(128);
      for (let i = 0; i < data.length; i++) data[i] = i * 2;

      const encoded = addFEC(data);
      // Introduce 3 errors (well within 8 error limit)
      encoded[10] ^= 0xFF;
      encoded[50] ^= 0xFF;
      encoded[100] ^= 0xFF;

      const { data: decoded, success, correctedErrors } = decodeFEC(encoded);

      expect(success).toBe(true);
      expect(decoded).toEqual(data);
      expect(correctedErrors).toBe(3);
    });
  });

  describe('Full encode/decode roundtrip', () => {
    it('should encode and decode "hello world" message', async () => {
      const message = 'hello world';
      const result = await encodeString(message);

      // Verify encoding produced valid output
      expect(result.audio.length).toBeGreaterThan(0);
      expect(result.checksum).toHaveLength(64);
      expect(result.stats.originalSize).toBe(message.length);
    });

    it('should handle config file payload', async () => {
      const configFile = `[Settings]
ApiKey = ABCD1234567890
ServerAddress = 10.0.0.2/24
Timeout = 30

[Connection]
Host = server.example.com
Port = 8080
SecretToken = XYZ0987654321`;

      const result = await encodeString(configFile);

      expect(result.audio.length).toBeGreaterThan(0);
      expect(result.stats.originalSize).toBe(configFile.length);
      // Config files usually compress well
      expect(result.stats.compressed).toBe(true);
    });

    it('should packetize and reassemble payload', () => {
      const originalText = 'Test payload for packetization. '.repeat(20);
      const originalBytes = stringToBytes(originalText);

      const { data: maybeCompressed, compressed } = tryCompress(originalBytes);
      const { headerFrame, dataFrames, sessionId } = packetize(
        maybeCompressed,
        originalBytes.length,
        compressed
      );

      // Parse header
      const header = parseHeaderFrame(headerFrame);
      expect(header).not.toBeNull();
      expect(header!.totalFrames).toBe(dataFrames.length);

      // Collect frames
      const collector = new FrameCollector();
      collector.setHeader(header!);

      for (const frame of dataFrames) {
        const parsed = parseDataFrame(frame);
        expect(parsed).not.toBeNull();
        // In compact format, sessionId comes from header, not data frame
        collector.addFrame(parsed!.frameIndex, parsed!.payload, header!.sessionId);
      }

      expect(collector.isComplete()).toBe(true);

      // Reassemble
      const reassembled = collector.reassemble();
      expect(reassembled).not.toBeNull();
      expect(reassembled!.length).toBe(maybeCompressed.length);

      // Decompress if needed
      const final = compressed ? decompress(reassembled!) : reassembled!;
      expect(bytesToString(final)).toBe(originalText);
    });
  });
});
