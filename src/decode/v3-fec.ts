/**
 * v3 FEC Decoding: Viterbi + Descramble + RS
 *
 * Decodes v3 FEC encoded frames using:
 * 1. Viterbi decoder for convolutional code
 * 2. Descrambler to reverse scrambling
 * 3. RS decoder for burst error correction
 *
 * Supports both hard-decision (from bytes) and soft-decision (from float values) decoding.
 */

import { RSDecoder } from '../lib/reed-solomon';
import { FRAME } from '../utils/constants';
import { descramble, LFSR_SEED } from '../encode/scramble';
import { CONVOLUTIONAL_CONFIG } from '../encode/convolutional';
import { V3_FEC_CONFIG, getOriginalBitCount } from '../encode/v3-fec';
import {
  ViterbiDecoder,
  viterbiDecode,
  viterbiDecodeSoft,
  unpackBits,
  hardToSoft,
} from './viterbi';

// Cache decoder instance
let rsDecoder: RSDecoder | null = null;

function getRSDecoder(): RSDecoder {
  if (!rsDecoder) {
    rsDecoder = new RSDecoder(V3_FEC_CONFIG.RS_PARITY_SIZE);
  }
  return rsDecoder;
}

export interface V3FECDecodeResult {
  data: Uint8Array;
  correctedErrors: number;
  viterbiSuccess: boolean;
  rsSuccess: boolean;
  success: boolean;
}

/**
 * Decode v3 FEC encoded frame (hard-decision)
 *
 * @param received - Received encoded bytes
 * @param frameType - 'header' or 'data'
 * @param payloadSize - For data frames, expected payload size
 * @returns Decoded frame data
 */
export function decodeV3FEC(
  received: Uint8Array,
  frameType: 'header' | 'data',
  payloadSize: number = 0
): V3FECDecodeResult {
  // Get original bit count for Viterbi decoder
  const originalBitCount = getOriginalBitCount(frameType, payloadSize);

  // Step 1: Viterbi decode (convolutional)
  let viterbiOutput: Uint8Array;
  try {
    viterbiOutput = viterbiDecode(received, originalBitCount, V3_FEC_CONFIG.USE_PUNCTURING);
  } catch (err) {
    console.warn('[v3-FEC] Viterbi decode failed:', (err as Error).message);
    return {
      data: new Uint8Array(0),
      correctedErrors: -1,
      viterbiSuccess: false,
      rsSuccess: false,
      success: false,
    };
  }

  // Step 2: Descramble
  const descrambled = descramble(viterbiOutput, V3_FEC_CONFIG.SCRAMBLER_SEED);

  // Step 3: RS decode
  const decoder = getRSDecoder();
  try {
    const { data, correctedErrors } = decoder.decode(descrambled);
    if (correctedErrors > 0) {
      console.log(`[v3-FEC] Corrected ${correctedErrors} byte errors`);
    }
    return {
      data,
      correctedErrors,
      viterbiSuccess: true,
      rsSuccess: true,
      success: true,
    };
  } catch (err) {
    console.warn('[v3-FEC] RS decode failed:', (err as Error).message);
    // Return data without RS parity (may still be usable)
    const dataWithoutParity = descrambled.subarray(
      0,
      descrambled.length - V3_FEC_CONFIG.RS_PARITY_SIZE
    );
    return {
      data: dataWithoutParity,
      correctedErrors: -1,
      viterbiSuccess: true,
      rsSuccess: false,
      success: false,
    };
  }
}

/**
 * Decode v3 FEC with soft-decision input
 *
 * @param softBits - Soft values (0.0-1.0) for each received bit
 * @param frameType - 'header' or 'data'
 * @param payloadSize - For data frames, expected payload size
 * @returns Decoded frame data
 */
export function decodeV3FECSoft(
  softBits: number[],
  frameType: 'header' | 'data',
  payloadSize: number = 0
): V3FECDecodeResult {
  // Get original bit count for Viterbi decoder
  const originalBitCount = getOriginalBitCount(frameType, payloadSize);

  // Step 1: Viterbi decode with soft decision
  let viterbiOutput: Uint8Array;
  try {
    viterbiOutput = viterbiDecodeSoft(softBits, originalBitCount, V3_FEC_CONFIG.USE_PUNCTURING);
  } catch (err) {
    console.warn('[v3-FEC] Soft Viterbi decode failed:', (err as Error).message);
    return {
      data: new Uint8Array(0),
      correctedErrors: -1,
      viterbiSuccess: false,
      rsSuccess: false,
      success: false,
    };
  }

  // Step 2: Descramble
  const descrambled = descramble(viterbiOutput, V3_FEC_CONFIG.SCRAMBLER_SEED);

  // Step 3: RS decode
  const decoder = getRSDecoder();
  try {
    const { data, correctedErrors } = decoder.decode(descrambled);
    if (correctedErrors > 0) {
      console.log(`[v3-FEC] Soft decode corrected ${correctedErrors} byte errors`);
    }
    return {
      data,
      correctedErrors,
      viterbiSuccess: true,
      rsSuccess: true,
      success: true,
    };
  } catch (err) {
    console.warn('[v3-FEC] RS decode failed after Viterbi:', (err as Error).message);
    const dataWithoutParity = descrambled.subarray(
      0,
      descrambled.length - V3_FEC_CONFIG.RS_PARITY_SIZE
    );
    return {
      data: dataWithoutParity,
      correctedErrors: -1,
      viterbiSuccess: true,
      rsSuccess: false,
      success: false,
    };
  }
}

/**
 * Decode v3 header frame (hard decision)
 */
export function decodeHeaderV3FEC(received: Uint8Array): V3FECDecodeResult {
  return decodeV3FEC(received, 'header');
}

/**
 * Decode v3 header frame with soft decision
 */
export function decodeHeaderV3FECSoft(softBits: number[]): V3FECDecodeResult {
  return decodeV3FECSoft(softBits, 'header');
}

/**
 * Decode v3 data frame (hard decision)
 */
export function decodeDataV3FEC(
  received: Uint8Array,
  payloadSize: number
): V3FECDecodeResult {
  return decodeV3FEC(received, 'data', payloadSize);
}

/**
 * Decode v3 data frame with soft decision
 */
export function decodeDataV3FECSoft(
  softBits: number[],
  payloadSize: number
): V3FECDecodeResult {
  return decodeV3FECSoft(softBits, 'data', payloadSize);
}

/**
 * Decode header with redundancy (two copies)
 */
export function decodeHeaderV3FECWithRedundancy(
  copy1: Uint8Array,
  copy2: Uint8Array
): V3FECDecodeResult {
  const result1 = decodeHeaderV3FEC(copy1);
  const result2 = decodeHeaderV3FEC(copy2);

  // If both succeeded, use the one with fewer errors
  if (result1.success && result2.success) {
    const best = result1.correctedErrors <= result2.correctedErrors ? result1 : result2;
    console.log(`[v3-FEC] Header decoded from ${result1.correctedErrors <= result2.correctedErrors ? 'copy1' : 'copy2'}`);
    return best;
  }

  // If only one succeeded, use that one
  if (result1.success) {
    console.log('[v3-FEC] Header decoded from copy1 (copy2 failed)');
    return result1;
  }
  if (result2.success) {
    console.log('[v3-FEC] Header decoded from copy2 (copy1 failed)');
    return result2;
  }

  // Both failed - return first result
  console.warn('[v3-FEC] Both header copies failed decode');
  return result1;
}

/**
 * Get expected v3 encoded size for header
 * Used to calculate how many symbols to read
 */
export function getV3HeaderEncodedSize(): number {
  const rawSize = FRAME.HEADER_SIZE;
  const rsSize = rawSize + V3_FEC_CONFIG.RS_PARITY_SIZE;
  const bitCount = rsSize * 8;
  const tailBits = CONVOLUTIONAL_CONFIG.MEMORY;
  const totalBits = bitCount + tailBits;

  if (V3_FEC_CONFIG.USE_PUNCTURING) {
    const outputBits = Math.ceil(totalBits * 4 / 3);
    return Math.ceil(outputBits / 8);
  } else {
    const outputBits = totalBits * 2;
    return Math.ceil(outputBits / 8);
  }
}

/**
 * Get expected v3 encoded size for a data frame
 */
export function getV3DataEncodedSize(payloadSize: number): number {
  const rawSize = 3 + payloadSize; // 3 byte header + payload
  const rsSize = rawSize + V3_FEC_CONFIG.RS_PARITY_SIZE;
  const bitCount = rsSize * 8;
  const tailBits = CONVOLUTIONAL_CONFIG.MEMORY;
  const totalBits = bitCount + tailBits;

  if (V3_FEC_CONFIG.USE_PUNCTURING) {
    const outputBits = Math.ceil(totalBits * 4 / 3);
    return Math.ceil(outputBits / 8);
  } else {
    const outputBits = totalBits * 2;
    return Math.ceil(outputBits / 8);
  }
}
