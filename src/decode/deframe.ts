/**
 * Frame reassembly from received symbols - COMPACT FORMAT
 *
 * Header (12 bytes):
 *   [0-1]  Magic "N1"
 *   [2]    Version (4 bits) + Flags (4 bits: bit0=compressed)
 *   [3]    Total frames (1 byte, up to 255)
 *   [4-5]  Payload length (2 bytes, up to 64KB)
 *   [6-7]  Original length (2 bytes, up to 64KB)
 *   [8-9]  Session ID (2 bytes)
 *   [10-11] CRC16
 *
 * Data frame (variable length):
 *   [0]    Magic "D"
 *   [1]    Frame index (1 byte)
 *   [2]    Payload length (1 byte, actual data in this frame)
 *   [3..n] Payload (variable, no padding)
 */
import { FRAME_V3 } from '../utils/constants';
import { ProtocolVersion } from '../encode/frame';
import { readUint16LE, bytesToString } from '../utils/helpers';

// Flag bits (must match encode/frame.ts)
const FLAG_COMPRESSED = 0x01;     // bit 0: data is compressed
const FLAG_ENCRYPTED = 0x02;      // bit 1: data is encrypted
const FLAG_CRC32_PRESENT = 0x04;  // bit 2: CRC32 appended to payload (for unencrypted data)

export interface HeaderInfo {
  magic: string;
  version: number;
  flags: number;
  sessionId: number;
  totalFrames: number;
  payloadLength: number;
  originalLength: number;
  compressionAlgo: number;
  compressed: boolean;
  encrypted: boolean;
  /** CRC32 is appended to payload (for unencrypted data integrity) */
  hasCrc32: boolean;
  crcValid: boolean;
  /** Protocol version detected from magic bytes */
  protocolVersion: ProtocolVersion;
}

export interface DataFrameInfo {
  magic: string;
  frameIndex: number;
  payloadLength: number;
  payload: Uint8Array;
  crcValid: boolean; // Always true for compact format (RS handles errors)
}

// CRC16-CCITT for compact header verification
function crc16(data: Uint8Array): number {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc <<= 1;
      }
    }
  }
  return crc & 0xFFFF;
}

/**
 * Parse compact header frame (after RS/Viterbi decoding)
 * Input: 12-byte header
 *
 * Currently supports v3 protocol (magic "N3")
 * Protocol version detection is preserved for future extensibility
 */
export function parseHeaderFrame(frame: Uint8Array): HeaderInfo | null {
  if (frame.length < FRAME_V3.HEADER_SIZE) {
    console.log('[Deframe] Header too short:', frame.length, 'expected', FRAME_V3.HEADER_SIZE);
    return null;
  }

  // Check magic - currently only v3 (magic "N3") is supported
  // Version detection is preserved for future protocol versions
  const magic = bytesToString(frame.subarray(0, 2));
  let protocolVersion: ProtocolVersion;

  if (magic === FRAME_V3.HEADER_MAGIC) {
    protocolVersion = 'v3';
  } else {
    console.log('[Deframe] Invalid magic:', magic, 'expected', FRAME_V3.HEADER_MAGIC);
    return null;
  }

  // Verify CRC16 of bytes 0-9
  const storedCRC = readUint16LE(frame, 10);
  const calculatedCRC = crc16(frame.subarray(0, 10));
  const crcValid = storedCRC === calculatedCRC;

  if (!crcValid) {
    console.log('[Deframe] CRC16 mismatch: stored', storedCRC.toString(16), 'calculated', calculatedCRC.toString(16));
  }

  // Version (high 4 bits) + Flags (low 4 bits)
  const versionFlags = frame[2];
  const version = (versionFlags >> 4) & 0x0F;
  const flags = versionFlags & 0x0F;

  return {
    magic,
    version,
    flags,
    sessionId: readUint16LE(frame, 8),
    totalFrames: frame[3],
    payloadLength: readUint16LE(frame, 4),
    originalLength: readUint16LE(frame, 6),
    compressionAlgo: flags & 0x0F, // Compression in flags
    compressed: (flags & FLAG_COMPRESSED) !== 0,
    encrypted: (flags & FLAG_ENCRYPTED) !== 0,
    hasCrc32: (flags & FLAG_CRC32_PRESENT) !== 0,
    crcValid,
    protocolVersion,
  };
}

/**
 * Parse compact data frame (after RS decoding)
 * Input: variable length (3 + payloadLength bytes)
 *
 * Format:
 *   [0]    Magic "D"
 *   [1]    Frame index (1-based)
 *   [2]    Payload length
 *   [3..n] Payload
 */
export function parseDataFrame(frame: Uint8Array): DataFrameInfo | null {
  if (frame.length < 3) {
    console.log('[Deframe] Data frame too short:', frame.length);
    return null;
  }

  // Check magic "D"
  const magic = String.fromCharCode(frame[0]);
  if (magic !== FRAME_V3.DATA_MAGIC) {
    console.log('[Deframe] Invalid data magic:', frame[0], 'expected', FRAME_V3.DATA_MAGIC.charCodeAt(0));
    return null;
  }

  const frameIndex = frame[1];
  const payloadLength = frame[2];

  // Verify we have enough data
  if (frame.length < 3 + payloadLength) {
    console.log('[Deframe] Data frame truncated: have', frame.length, 'need', 3 + payloadLength);
    return null;
  }

  return {
    magic,
    frameIndex,
    payloadLength,
    payload: frame.subarray(3, 3 + payloadLength),
    crcValid: true, // RS handles error detection
  };
}

/**
 * Frame collector - accumulates received frames
 */
export class FrameCollector {
  private headerInfo: HeaderInfo | null = null;
  private frames: Map<number, Uint8Array> = new Map();
  private sessionId: number | null = null;

  /**
   * Reset collector state
   */
  reset(): void {
    this.headerInfo = null;
    this.frames.clear();
    this.sessionId = null;
  }

  /**
   * Set header information
   */
  setHeader(header: HeaderInfo): void {
    this.headerInfo = header;
    this.sessionId = header.sessionId;
  }

  /**
   * Add a received data frame
   * Returns true if frame was accepted
   */
  addFrame(frameIndex: number, payload: Uint8Array, sessionId: number): boolean {
    // Check session ID matches
    if (this.sessionId !== null && sessionId !== this.sessionId) {
      return false;
    }

    // Don't overwrite if we already have this frame
    if (this.frames.has(frameIndex)) {
      return true;
    }

    this.frames.set(frameIndex, new Uint8Array(payload));
    return true;
  }

  /**
   * Get header info
   */
  getHeader(): HeaderInfo | null {
    return this.headerInfo;
  }

  /**
   * Check if all frames have been received
   */
  isComplete(): boolean {
    if (!this.headerInfo) return false;

    for (let i = 1; i <= this.headerInfo.totalFrames; i++) {
      if (!this.frames.has(i)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Get missing frame indices
   */
  getMissingFrames(): number[] {
    if (!this.headerInfo) return [];

    const missing: number[] = [];
    for (let i = 1; i <= this.headerInfo.totalFrames; i++) {
      if (!this.frames.has(i)) {
        missing.push(i);
      }
    }
    return missing;
  }

  /**
   * Get progress (0-1)
   */
  getProgress(): number {
    if (!this.headerInfo) return 0;
    return this.frames.size / this.headerInfo.totalFrames;
  }

  /**
   * Get received frame count
   */
  getReceivedCount(): number {
    return this.frames.size;
  }

  /**
   * Get total frame count
   */
  getTotalFrames(): number {
    return this.headerInfo?.totalFrames ?? 0;
  }

  /**
   * Reassemble payload from received frames
   * Returns null if not all frames received
   */
  reassemble(): Uint8Array | null {
    if (!this.headerInfo || !this.isComplete()) {
      return null;
    }

    const payloadLength = this.headerInfo.payloadLength;
    const result = new Uint8Array(payloadLength);

    let offset = 0;
    for (let i = 1; i <= this.headerInfo.totalFrames; i++) {
      const framePayload = this.frames.get(i)!;
      const remaining = payloadLength - offset;
      const toCopy = Math.min(framePayload.length, remaining);

      result.set(framePayload.subarray(0, toCopy), offset);
      offset += toCopy;
    }

    return result;
  }
}
