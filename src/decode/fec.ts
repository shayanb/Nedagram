/**
 * Reed-Solomon FEC decoding
 *
 * Supports two modes:
 * - Normal: 16 parity bytes (correct up to 8 errors)
 * - Robust: 32 parity bytes (correct up to 16 errors)
 *
 * Auto-detection: Try both parity sizes when decoding headers
 */
import { RSDecoder } from '../lib/reed-solomon';
import { FRAME, setFECMode, type FECMode } from '../utils/constants';

// Parity sizes for each mode
const PARITY_NORMAL = 16;
const PARITY_ROBUST = 32;

// Cache decoders by parity size to avoid recreating
const decoderCache = new Map<number, RSDecoder>();

function getDecoder(paritySize: number): RSDecoder {
  if (!decoderCache.has(paritySize)) {
    decoderCache.set(paritySize, new RSDecoder(paritySize));
  }
  return decoderCache.get(paritySize)!;
}

export interface FECDecodeResult {
  data: Uint8Array;
  correctedErrors: number;
  success: boolean;
  detectedParitySize?: number; // For auto-detection
}

/**
 * Decode and remove FEC from received data
 * Uses current FRAME.RS_PARITY_SIZE (set by FEC mode)
 */
export function decodeFEC(received: Uint8Array): FECDecodeResult {
  const decoder = getDecoder(FRAME.RS_PARITY_SIZE);
  try {
    const { data, correctedErrors } = decoder.decode(received);
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
 * Try to decode header with a specific parity size
 * Used for auto-detection
 */
function decodeHeaderWithParitySize(received: Uint8Array, paritySize: number): FECDecodeResult {
  const headerSize = FRAME.HEADER_SIZE; // 12 bytes
  const expectedSize = headerSize + paritySize;

  if (received.length !== expectedSize) {
    return {
      data: new Uint8Array(0),
      correctedErrors: -1,
      success: false,
      detectedParitySize: paritySize,
    };
  }

  const decoder = getDecoder(paritySize);
  try {
    const { data, correctedErrors } = decoder.decode(received);
    if (correctedErrors > 0) {
      console.log(`[FEC] Corrected ${correctedErrors} byte errors (parity=${paritySize})`);
    }
    return { data, correctedErrors, success: true, detectedParitySize: paritySize };
  } catch (err) {
    console.log(`[FEC] RS decode failed with parity=${paritySize}:`, (err as Error).message);
    return {
      data: received.subarray(0, received.length - paritySize),
      correctedErrors: -1,
      success: false,
      detectedParitySize: paritySize,
    };
  }
}

/**
 * Auto-detect FEC mode by trying both parity sizes
 * Returns the result from whichever mode succeeds
 * Sets the global FEC mode for subsequent data frame decoding
 */
export function autoDetectAndDecodeHeader(
  bytesNormal: Uint8Array,  // 28 bytes (12 + 16)
  bytesRobust: Uint8Array   // 44 bytes (12 + 32)
): FECDecodeResult & { detectedMode: FECMode } {
  // Try normal mode first (faster, more common)
  const resultNormal = decodeHeaderWithParitySize(bytesNormal, PARITY_NORMAL);

  if (resultNormal.success) {
    // Verify it looks like a valid header (check magic)
    if (resultNormal.data.length >= 2) {
      const magic = String.fromCharCode(resultNormal.data[0], resultNormal.data[1]);
      if (magic === FRAME.HEADER_MAGIC) {
        console.log('[FEC] Auto-detected Normal FEC mode (16 parity bytes)');
        setFECMode('normal');
        return { ...resultNormal, detectedMode: 'normal' };
      }
    }
  }

  // Try robust mode
  const resultRobust = decodeHeaderWithParitySize(bytesRobust, PARITY_ROBUST);

  if (resultRobust.success) {
    // Verify magic
    if (resultRobust.data.length >= 2) {
      const magic = String.fromCharCode(resultRobust.data[0], resultRobust.data[1]);
      if (magic === FRAME.HEADER_MAGIC) {
        console.log('[FEC] Auto-detected Robust FEC mode (32 parity bytes)');
        setFECMode('robust');
        return { ...resultRobust, detectedMode: 'robust' };
      }
    }
  }

  // Neither worked - return normal result as default
  console.warn('[FEC] Auto-detection failed, neither mode decoded successfully');
  return { ...resultNormal, detectedMode: 'normal' };
}

/**
 * Auto-detect with redundancy (two header copies)
 */
export function autoDetectAndDecodeHeaderWithRedundancy(
  copy1Normal: Uint8Array,
  copy1Robust: Uint8Array,
  copy2Normal: Uint8Array,
  copy2Robust: Uint8Array
): FECDecodeResult & { detectedMode: FECMode } {
  // Try first copy
  const result1 = autoDetectAndDecodeHeader(copy1Normal, copy1Robust);

  if (result1.success) {
    // Try second copy with the detected mode for best result
    const paritySize = result1.detectedMode === 'normal' ? PARITY_NORMAL : PARITY_ROBUST;
    const copy2 = result1.detectedMode === 'normal' ? copy2Normal : copy2Robust;
    const result2 = decodeHeaderWithParitySize(copy2, paritySize);

    if (result2.success && result2.correctedErrors < result1.correctedErrors) {
      console.log('[FEC] Using second header copy (fewer errors)');
      return { ...result2, detectedMode: result1.detectedMode };
    }

    return result1;
  }

  // First copy failed, try second
  const result2 = autoDetectAndDecodeHeader(copy2Normal, copy2Robust);
  if (result2.success) {
    console.log('[FEC] Header decoded from second copy');
    return result2;
  }

  // Both failed
  return result1;
}

/**
 * Get expected header sizes for both FEC modes
 */
export function getHeaderSizes(): { normal: number; robust: number } {
  return {
    normal: FRAME.HEADER_SIZE + PARITY_NORMAL,  // 12 + 16 = 28
    robust: FRAME.HEADER_SIZE + PARITY_ROBUST,  // 12 + 32 = 44
  };
}
