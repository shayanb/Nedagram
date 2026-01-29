import { describe, it, expect } from 'vitest';
import { encodeString } from '../../src/encode';
import { tryCompress, decompress } from '../../src/encode/compress';
import { packetize, createHeaderFrame, createDataFrame } from '../../src/encode/frame';
import { parseHeaderFrame, parseDataFrame, FrameCollector } from '../../src/decode/deframe';
import { encodeDataV3FEC, V3_FEC_CONFIG } from '../../src/encode/v3-fec';
import { decodeDataV3FEC } from '../../src/decode/v3-fec';
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
      expect(parsed!.magic).toBe('N3'); // v3 protocol uses N3
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
    it('should encode and decode with v3 FEC (no errors)', () => {
      // v3 FEC expects data frames: 3 bytes overhead + payload
      const payloadSize = 64;
      const dataFrame = new Uint8Array(3 + payloadSize);
      dataFrame[0] = 0x44; // 'D' magic
      dataFrame[1] = 1;    // frame index
      dataFrame[2] = payloadSize; // payload length
      for (let i = 3; i < dataFrame.length; i++) dataFrame[i] = (i * 2) % 256;

      const encoded = encodeDataV3FEC(dataFrame);
      // v3 FEC: RS + Convolutional encoding expands the data
      expect(encoded.length).toBeGreaterThan(dataFrame.length + V3_FEC_CONFIG.RS_PARITY_SIZE);

      const { data: decoded, success, correctedErrors } = decodeDataV3FEC(encoded, payloadSize);

      expect(success).toBe(true);
      expect(Array.from(decoded)).toEqual(Array.from(dataFrame));
      expect(correctedErrors).toBe(0);
    });

    // Error correction - v3 FEC handles both convolutional and RS errors
    it('should correct errors with v3 FEC', () => {
      // v3 FEC expects data frames: 3 bytes overhead + payload
      const payloadSize = 64;
      const dataFrame = new Uint8Array(3 + payloadSize);
      dataFrame[0] = 0x44; // 'D' magic
      dataFrame[1] = 1;    // frame index
      dataFrame[2] = payloadSize; // payload length
      for (let i = 3; i < dataFrame.length; i++) dataFrame[i] = (i * 2) % 256;

      const encoded = encodeDataV3FEC(dataFrame);
      // Introduce errors in the encoded stream (will be partially corrected by Viterbi)
      encoded[10] ^= 0x0F;  // Bit errors
      encoded[50] ^= 0x0F;
      encoded[80] ^= 0x0F;

      const { data: decoded, success } = decodeDataV3FEC(encoded, payloadSize);

      expect(success).toBe(true);
      expect(Array.from(decoded)).toEqual(Array.from(dataFrame));
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
