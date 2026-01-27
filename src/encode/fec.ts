/**
 * Forward Error Correction using Reed-Solomon
 *
 * Supports two modes:
 * - Normal: 16 parity bytes (correct up to 8 errors, faster)
 * - Robust: 32 parity bytes (correct up to 16 errors, slower but more reliable)
 */
import { RSEncoder } from '../lib/reed-solomon';
import { FRAME } from '../utils/constants';

// Cache encoders by parity size to avoid recreating
const encoderCache = new Map<number, RSEncoder>();

function getEncoder(paritySize: number): RSEncoder {
  if (!encoderCache.has(paritySize)) {
    encoderCache.set(paritySize, new RSEncoder(paritySize));
  }
  return encoderCache.get(paritySize)!;
}

/**
 * Add Reed-Solomon FEC to a frame
 * Uses current FRAME.RS_PARITY_SIZE (set by FEC mode)
 */
export function addFEC(frame: Uint8Array): Uint8Array {
  const encoder = getEncoder(FRAME.RS_PARITY_SIZE);
  return encoder.encode(frame);
}

/**
 * Add FEC to header frame
 */
export function addHeaderFEC(headerFrame: Uint8Array): Uint8Array {
  return addFEC(headerFrame);
}

/**
 * Add FEC to data frame
 */
export function addDataFEC(dataFrame: Uint8Array): Uint8Array {
  return addFEC(dataFrame);
}

/**
 * Encode all frames with FEC
 */
export function encodeWithFEC(
  headerFrame: Uint8Array,
  dataFrames: Uint8Array[]
): { encodedHeader: Uint8Array; encodedDataFrames: Uint8Array[] } {
  const encodedHeader = addHeaderFEC(headerFrame);
  const encodedDataFrames = dataFrames.map(addDataFEC);

  return { encodedHeader, encodedDataFrames };
}

/**
 * Get total encoded size for a payload
 */
export function calculateEncodedSize(payloadBytes: number): {
  dataFrames: number;
  headerBytes: number;
  dataBytes: number;
  totalBytes: number;
} {
  // Use optimal frame size
  const frameSize = payloadBytes <= 32 ? 32 : payloadBytes <= 64 ? 64 : FRAME.PAYLOAD_SIZE;
  const dataFrames = Math.ceil(payloadBytes / frameSize);

  // Header: 12 bytes + 16 RS = 28 bytes, sent once (small data) or twice (large)
  const headerRepeat = dataFrames > 1 ? 2 : 1;
  const headerBytes = (FRAME.HEADER_SIZE + FRAME.RS_PARITY_SIZE) * headerRepeat;

  // Data frames: variable length + 16 RS parity
  // Estimate: average payload per frame + 3 byte header + 16 RS
  const avgFrameData = Math.min(frameSize, Math.ceil(payloadBytes / dataFrames));
  const dataBytes = dataFrames * (3 + avgFrameData + FRAME.RS_PARITY_SIZE);

  return {
    dataFrames,
    headerBytes,
    dataBytes,
    totalBytes: headerBytes + dataBytes,
  };
}
