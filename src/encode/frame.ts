/**
 * Frame packetization for audio transmission - COMPACT FORMAT
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
 *   No CRC - RS handles error detection
 */
import { FRAME } from '../utils/constants';
import { crc32 } from '../lib/crc32';
import {
  writeUint16LE,
  generateSessionId,
  stringToBytes,
} from '../utils/helpers';

export interface HeaderFrame {
  magic: string;
  version: number;
  flags: number;
  sessionId: number;
  totalFrames: number;
  payloadLength: number;
  originalLength: number;
  compressionAlgo: number;
}

export interface DataFrame {
  magic: string;
  frameIndex: number;
  payload: Uint8Array;
}

// CRC16-CCITT for compact header
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

// Flag bits
export const FLAG_COMPRESSED = 0x01;  // bit 0: data is compressed
export const FLAG_ENCRYPTED = 0x02;   // bit 1: data is encrypted

/**
 * Create a compact header frame (12 bytes)
 */
export function createHeaderFrame(
  totalFrames: number,
  payloadLength: number,
  originalLength: number,
  compressed: boolean,
  encrypted: boolean = false,
  sessionId?: number
): { frame: Uint8Array; sessionId: number } {
  const sid = sessionId ?? (generateSessionId() & 0xFFFF); // 16-bit session ID
  const frame = new Uint8Array(FRAME.HEADER_SIZE);

  // Magic "N1"
  frame.set(stringToBytes(FRAME.HEADER_MAGIC), 0);

  // Version (high 4 bits) + Flags (low 4 bits)
  let flags = 0;
  if (compressed) flags |= FLAG_COMPRESSED;
  if (encrypted) flags |= FLAG_ENCRYPTED;
  const versionFlags = ((FRAME.CURRENT_VERSION & 0x0F) << 4) | (flags & 0x0F);
  frame[2] = versionFlags;

  // Total frames (1 byte)
  frame[3] = Math.min(totalFrames, 255);

  // Payload length (2 bytes)
  writeUint16LE(frame, 4, Math.min(payloadLength, 65535));

  // Original length (2 bytes)
  writeUint16LE(frame, 6, Math.min(originalLength, 65535));

  // Session ID (2 bytes)
  writeUint16LE(frame, 8, sid);

  // CRC16 of bytes 0-9
  const crc = crc16(frame.subarray(0, 10));
  writeUint16LE(frame, 10, crc);

  return { frame, sessionId: sid };
}

/**
 * Create a compact data frame (variable length, no padding)
 */
export function createDataFrame(
  sessionId: number,
  frameIndex: number,
  payload: Uint8Array
): Uint8Array {
  // Data frame: 1 (magic) + 1 (index) + 1 (length) + payload (no padding)
  const payloadLen = Math.min(payload.length, 255);
  const frame = new Uint8Array(3 + payloadLen);

  // Magic "D"
  frame[0] = FRAME.DATA_MAGIC.charCodeAt(0);

  // Frame index
  frame[1] = frameIndex & 0xFF;

  // Payload length
  frame[2] = payloadLen;

  // Payload (actual data, no padding!)
  frame.set(payload.subarray(0, payloadLen), 3);

  return frame;
}

/**
 * Calculate optimal frame size for payload
 */
function getOptimalFrameSize(totalPayload: number): number {
  // For very small payloads, use smaller frames
  if (totalPayload <= 32) return 32;
  if (totalPayload <= 64) return 64;
  return FRAME.PAYLOAD_SIZE; // 128 for larger data
}

/**
 * Packetize payload data into frames
 */
export function packetize(
  payload: Uint8Array,
  originalLength: number,
  compressed: boolean,
  encrypted: boolean = false
): { headerFrame: Uint8Array; dataFrames: Uint8Array[]; sessionId: number } {
  // Use optimal frame size based on payload
  const frameSize = getOptimalFrameSize(payload.length);

  // Calculate number of data frames needed
  const totalDataFrames = Math.ceil(payload.length / frameSize);

  // Create header frame
  const { frame: headerFrame, sessionId } = createHeaderFrame(
    totalDataFrames,
    payload.length,
    originalLength,
    compressed,
    encrypted
  );

  // Create data frames with minimal overhead
  const dataFrames: Uint8Array[] = [];
  for (let i = 0; i < totalDataFrames; i++) {
    const start = i * frameSize;
    const end = Math.min(start + frameSize, payload.length);
    const framePayload = payload.subarray(start, end);

    // Frame index is 1-based (0 is header)
    const dataFrame = createDataFrame(sessionId, i + 1, framePayload);
    dataFrames.push(dataFrame);
  }

  return { headerFrame, dataFrames, sessionId };
}
