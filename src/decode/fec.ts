/**
 * Reed-Solomon FEC decoding
 *
 * Uses 16 parity bytes, can correct up to 8 byte errors per frame
 */
import { RSDecoder } from '../lib/reed-solomon';
import { FRAME } from '../utils/constants';

// Cache decoder to avoid recreating
let decoder: RSDecoder | null = null;

function getDecoder(): RSDecoder {
  if (!decoder) {
    decoder = new RSDecoder(FRAME.RS_PARITY_SIZE);
  }
  return decoder;
}

export interface FECDecodeResult {
  data: Uint8Array;
  correctedErrors: number;
  success: boolean;
}

/**
 * Decode and remove FEC from received data
 */
export function decodeFEC(received: Uint8Array): FECDecodeResult {
  const dec = getDecoder();
  try {
    const { data, correctedErrors } = dec.decode(received);
    if (correctedErrors > 0) {
      console.log(`[FEC] Corrected ${correctedErrors} byte errors`);
    }
    return { data, correctedErrors, success: true };
  } catch (err) {
    console.warn('[FEC] RS decode failed:', (err as Error).message);
    return {
      data: received.subarray(0, received.length - FRAME.RS_PARITY_SIZE),
      correctedErrors: -1,
      success: false,
    };
  }
}

/**
 * Decode compact header frame (28 bytes → 12 bytes)
 * Header: 12 bytes + 16 RS parity = 28 bytes
 */
export function decodeHeaderFEC(received: Uint8Array): FECDecodeResult {
  const expectedSize = FRAME.HEADER_SIZE + FRAME.RS_PARITY_SIZE; // 12 + 16 = 28

  if (received.length !== expectedSize) {
    console.log('[FEC] Header size mismatch:', received.length, 'expected', expectedSize);
    return {
      data: new Uint8Array(0),
      correctedErrors: -1,
      success: false,
    };
  }

  return decodeFEC(received);
}

/**
 * Decode compact data frame (variable length)
 * Data frame: (3 + payload) + 16 RS parity
 * Minimum: 3 + 16 = 19 bytes
 */
export function decodeDataFEC(received: Uint8Array): FECDecodeResult {
  const minSize = 3 + FRAME.RS_PARITY_SIZE; // 19 bytes minimum

  if (received.length < minSize) {
    console.log('[FEC] Data frame too short:', received.length, 'minimum', minSize);
    return {
      data: new Uint8Array(0),
      correctedErrors: -1,
      success: false,
    };
  }

  return decodeFEC(received);
}

/**
 * Try to decode header from two copies (redundancy)
 * Uses the copy with fewer errors
 */
export function decodeHeaderWithRedundancy(
  copy1: Uint8Array,
  copy2: Uint8Array
): FECDecodeResult {
  const result1 = decodeHeaderFEC(copy1);
  const result2 = decodeHeaderFEC(copy2);

  // If both succeeded, use the one with fewer errors
  if (result1.success && result2.success) {
    const best = result1.correctedErrors <= result2.correctedErrors ? result1 : result2;
    console.log(`[FEC] Header decoded from ${result1.correctedErrors <= result2.correctedErrors ? 'copy1' : 'copy2'}`);
    return best;
  }

  // If only one succeeded, use that one
  if (result1.success) {
    console.log('[FEC] Header decoded from copy1 (copy2 failed)');
    return result1;
  }
  if (result2.success) {
    console.log('[FEC] Header decoded from copy2 (copy1 failed)');
    return result2;
  }

  // Both copies failed - return first result
  console.warn('[FEC] Both header copies failed RS decode');
  return result1;
}

/**
 * Get expected header size
 */
export function getHeaderSize(): number {
  return FRAME.HEADER_SIZE + FRAME.RS_PARITY_SIZE;  // 12 + 16 = 28
}
