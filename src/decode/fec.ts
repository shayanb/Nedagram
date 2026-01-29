/**
 * FEC decoding for v3 protocol
 *
 * Uses concatenated RS + Convolutional FEC with Viterbi decoding
 *
 * This module provides the interface used by the decoder.
 * Actual implementation is in v3-fec.ts
 */

import {
  decodeHeaderV3FEC,
  decodeDataV3FEC,
  decodeHeaderV3FECWithRedundancy,
  getV3HeaderEncodedSize,
  getV3DataEncodedSize,
  V3FECDecodeResult,
} from './v3-fec';

// Re-export result type for compatibility
export interface FECDecodeResult {
  data: Uint8Array;
  correctedErrors: number;
  success: boolean;
}

/**
 * Convert v3 result to standard FEC result
 */
function toFECResult(v3Result: V3FECDecodeResult): FECDecodeResult {
  return {
    data: v3Result.data,
    correctedErrors: v3Result.correctedErrors,
    success: v3Result.success,
  };
}

/**
 * Decode header frame with v3 FEC
 * Header is encoded with RS + Convolutional
 */
export function decodeHeaderFEC(received: Uint8Array): FECDecodeResult {
  return toFECResult(decodeHeaderV3FEC(received));
}

/**
 * Decode data frame with v3 FEC
 *
 * @param received - Received encoded bytes
 * @param payloadSize - Expected payload size (needed for v3 Viterbi)
 */
export function decodeDataFEC(received: Uint8Array, payloadSize?: number): FECDecodeResult {
  // If payload size not provided, estimate from received size
  // This is a fallback - callers should provide the expected size
  const size = payloadSize ?? estimatePayloadSize(received.length);
  return toFECResult(decodeDataV3FEC(received, size));
}

/**
 * Estimate payload size from encoded frame length
 * Used when payload size is not provided
 */
function estimatePayloadSize(encodedLength: number): number {
  // Work backwards from v3 encoded size
  // This is approximate - exact size requires knowing the original payload
  // For most cases, the caller should provide the expected size

  // Try common payload sizes and find the closest match
  const commonSizes = [128, 64, 32, 16, 8, 4, 1];

  for (const size of commonSizes) {
    const expectedEncoded = getV3DataEncodedSize(size);
    if (Math.abs(expectedEncoded - encodedLength) <= 2) {
      return size;
    }
  }

  // Fallback: estimate based on ratio
  // v3 encoding expands data by roughly 1.5x (RS) * 1.5x (conv) = 2.25x
  return Math.max(1, Math.floor(encodedLength / 2.25) - 3);
}

/**
 * Try to decode header from two copies (redundancy)
 * Uses the copy with fewer errors
 */
export function decodeHeaderWithRedundancy(
  copy1: Uint8Array,
  copy2: Uint8Array
): FECDecodeResult {
  return toFECResult(decodeHeaderV3FECWithRedundancy(copy1, copy2));
}

/**
 * Get expected v3 header encoded size
 */
export function getHeaderSize(): number {
  return getV3HeaderEncodedSize();
}

/**
 * Get expected v3 data frame encoded size
 */
export function getDataFrameSize(payloadSize: number): number {
  return getV3DataEncodedSize(payloadSize);
}
