/**
 * v3 FEC Encoding: Concatenated RS + Convolutional
 *
 * This module implements the v3 FEC scheme which concatenates:
 * - Outer code: Reed-Solomon (RS) for burst error correction
 * - Inner code: Convolutional with Viterbi decoding for random error correction
 *
 * The encoding order is: Data → RS encode → Scramble → Convolutional encode
 * The decoding order is: Viterbi decode → Descramble → RS decode → Data
 *
 * This concatenated scheme is the same used by Voyager spacecraft and
 * provides excellent error correction for noisy channels.
 */

import { RSEncoder } from '../lib/reed-solomon';
import { FRAME } from '../utils/constants';
import { scramble, LFSR_SEED } from './scramble';
import {
  ConvolutionalEncoder,
  CONVOLUTIONAL_CONFIG,
} from './convolutional';

// Cache encoder instances
const rsEncoderCache = new Map<number, RSEncoder>();

function getRSEncoder(paritySize: number): RSEncoder {
  if (!rsEncoderCache.has(paritySize)) {
    rsEncoderCache.set(paritySize, new RSEncoder(paritySize));
  }
  return rsEncoderCache.get(paritySize)!;
}

/**
 * v3 FEC configuration
 */
export const V3_FEC_CONFIG = {
  /** Use punctured rate 2/3 (1.5x expansion) */
  USE_PUNCTURING: true,

  /** RS parity bytes (same as v2) */
  RS_PARITY_SIZE: FRAME.RS_PARITY_SIZE,

  /** Convolutional rate after puncturing */
  CONV_RATE: 2 / 3,

  /** Scrambler seed */
  SCRAMBLER_SEED: LFSR_SEED,
} as const;

/**
 * Encode a frame with v3 FEC (RS + Scramble + Convolutional)
 *
 * @param frame - Raw frame data
 * @returns Encoded frame with FEC
 */
export function encodeV3FEC(frame: Uint8Array): Uint8Array {
  // Step 1: RS encode (add parity bytes)
  const rsEncoder = getRSEncoder(V3_FEC_CONFIG.RS_PARITY_SIZE);
  const rsEncoded = rsEncoder.encode(frame);

  // Step 2: Scramble (helps with sync and avoids long runs)
  const scrambled = scramble(rsEncoded, V3_FEC_CONFIG.SCRAMBLER_SEED);

  // Step 3: Convolutional encode
  const convEncoder = new ConvolutionalEncoder(V3_FEC_CONFIG.USE_PUNCTURING);
  const convEncoded = convEncoder.encodeBytes(scrambled);

  return convEncoded;
}

/**
 * Encode header frame with v3 FEC
 */
export function encodeHeaderV3FEC(headerFrame: Uint8Array): Uint8Array {
  return encodeV3FEC(headerFrame);
}

/**
 * Encode data frame with v3 FEC
 */
export function encodeDataV3FEC(dataFrame: Uint8Array): Uint8Array {
  return encodeV3FEC(dataFrame);
}

/**
 * Encode all frames with v3 FEC
 */
export function encodeWithV3FEC(
  headerFrame: Uint8Array,
  dataFrames: Uint8Array[]
): { encodedHeader: Uint8Array; encodedDataFrames: Uint8Array[] } {
  const encodedHeader = encodeHeaderV3FEC(headerFrame);
  const encodedDataFrames = dataFrames.map(encodeDataV3FEC);

  return { encodedHeader, encodedDataFrames };
}

/**
 * Calculate v3 encoded size for a raw frame
 *
 * @param rawBytes - Size of raw frame (before FEC)
 * @returns Size after v3 FEC encoding
 */
export function calculateV3EncodedSize(rawBytes: number): number {
  // RS adds parity bytes
  const rsSize = rawBytes + V3_FEC_CONFIG.RS_PARITY_SIZE;

  // Convolutional adds overhead based on rate
  // Rate 2/3 with tail bits: (bits + 6 tail) * 1.5 expansion
  const bitCount = rsSize * 8;
  const tailBits = CONVOLUTIONAL_CONFIG.MEMORY;
  const totalBits = bitCount + tailBits;

  if (V3_FEC_CONFIG.USE_PUNCTURING) {
    // Punctured rate 2/3: 4 bits out per 3 bits in
    const outputBits = Math.ceil(totalBits * 4 / 3);
    return Math.ceil(outputBits / 8);
  } else {
    // Rate 1/2: 2 bits out per 1 bit in
    const outputBits = totalBits * 2;
    return Math.ceil(outputBits / 8);
  }
}

/**
 * Calculate total v3 encoded size for a payload
 */
export function calculateV3TotalSize(payloadBytes: number): {
  dataFrames: number;
  headerBytes: number;
  dataBytes: number;
  totalBytes: number;
  overheadRatio: number;
} {
  // Use optimal frame size
  const frameSize = payloadBytes <= 32 ? 32 : payloadBytes <= 64 ? 64 : FRAME.PAYLOAD_SIZE;
  const dataFrames = Math.ceil(payloadBytes / frameSize);

  // Header: 12 bytes raw → v3 encoded
  const headerRepeat = dataFrames > 1 ? 2 : 1;
  const rawHeaderSize = FRAME.HEADER_SIZE;
  const headerBytes = calculateV3EncodedSize(rawHeaderSize) * headerRepeat;

  // Data frames: variable length
  let dataBytes = 0;
  for (let i = 0; i < dataFrames; i++) {
    const start = i * frameSize;
    const end = Math.min(start + frameSize, payloadBytes);
    const thisPayload = end - start;
    const rawFrameSize = 3 + thisPayload; // 3 byte header + payload
    dataBytes += calculateV3EncodedSize(rawFrameSize);
  }

  const totalBytes = headerBytes + dataBytes;

  // Calculate raw size for comparison
  const rawHeaderBytes = (rawHeaderSize + V3_FEC_CONFIG.RS_PARITY_SIZE) * headerRepeat;
  const rawDataBytes = dataFrames * (3 + frameSize + V3_FEC_CONFIG.RS_PARITY_SIZE);
  const rawTotal = rawHeaderBytes + rawDataBytes;

  // v3 adds ~1.5x overhead from convolutional on top of RS
  // This is the overhead compared to v2 (RS only)
  const overheadRatio = totalBytes / rawTotal;

  return {
    dataFrames,
    headerBytes,
    dataBytes,
    totalBytes,
    overheadRatio,
  };
}

/**
 * Get the number of original bits for a v3 encoded frame
 * Used by Viterbi decoder to know how many bits to expect
 *
 * @param frameType - 'header' or 'data'
 * @param payloadSize - For data frames, the payload size (0-128)
 */
export function getOriginalBitCount(
  frameType: 'header' | 'data',
  payloadSize: number = 0
): number {
  let rawBytes: number;

  if (frameType === 'header') {
    rawBytes = FRAME.HEADER_SIZE;
  } else {
    rawBytes = 3 + payloadSize; // 3 byte header + payload
  }

  // After RS encoding
  const rsSize = rawBytes + V3_FEC_CONFIG.RS_PARITY_SIZE;

  // Return bit count (what convolutional encoder received)
  return rsSize * 8;
}
