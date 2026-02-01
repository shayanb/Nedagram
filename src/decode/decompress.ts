/**
 * Decompression and decryption utilities
 */
import { decompress as pakoDecompress } from '../encode/compress';
import { FRAME } from '../utils/constants';
import { decrypt } from '../lib/crypto';
import { crc32 } from '../lib/crc32';

/**
 * Result of processing received payload
 */
export interface ProcessResult {
  success: boolean;
  data?: Uint8Array;
  error?: string;
  needsPassword?: boolean;
}

/**
 * Decrypt received payload
 * Returns null if decryption fails (wrong password)
 */
export async function decryptPayload(
  payload: Uint8Array,
  password: string
): Promise<Uint8Array | null> {
  return decrypt(payload, password);
}

/**
 * Decompress received payload based on compression algorithm
 */
export function decompressPayload(
  payload: Uint8Array,
  compressionAlgo: number,
  expectedOriginalLength: number
): Uint8Array {
  switch (compressionAlgo) {
    case FRAME.COMPRESSION_NONE:
      return payload;

    case FRAME.COMPRESSION_DEFLATE:
      try {
        const decompressed = pakoDecompress(payload);

        // Verify length matches expected
        if (decompressed.length !== expectedOriginalLength) {
          console.warn(
            `Decompressed length mismatch: got ${decompressed.length}, expected ${expectedOriginalLength}`
          );
        }

        return decompressed;
      } catch (err) {
        throw new Error('Decompression failed: ' + (err instanceof Error ? err.message : 'Unknown error'));
      }

    default:
      throw new Error(`Unknown compression algorithm: ${compressionAlgo}`);
  }
}

/**
 * Process received payload: verify CRC32 (if present), decrypt (if needed), then decompress
 * Order: Verify CRC32 → Decrypt → Decompress (reverse of encode order)
 */
export async function processPayload(
  payload: Uint8Array,
  encrypted: boolean,
  compressed: boolean,
  compressionAlgo: number,
  expectedOriginalLength: number,
  hasCrc32: boolean = false,
  password?: string
): Promise<ProcessResult> {
  let data = payload;

  // Step 1: Verify and strip CRC32 if present (for unencrypted data)
  // CRC32 is at the end of the payload, computed on the compressed data
  if (hasCrc32 && !encrypted) {
    if (data.length < 4) {
      return { success: false, error: 'Payload too short for CRC32 verification' };
    }

    // Extract CRC32 (last 4 bytes, little-endian)
    const storedCrc =
      data[data.length - 4] |
      (data[data.length - 3] << 8) |
      (data[data.length - 2] << 16) |
      (data[data.length - 1] << 24);

    // Data without CRC32
    const dataWithoutCrc = data.subarray(0, data.length - 4);

    // Verify CRC32
    const calculatedCrc = crc32(dataWithoutCrc);
    if ((calculatedCrc >>> 0) !== (storedCrc >>> 0)) {
      console.log('[Decompress] CRC32 mismatch: stored', storedCrc.toString(16), 'calculated', calculatedCrc.toString(16));
      return { success: false, error: 'Data integrity check failed (CRC32 mismatch)' };
    }

    data = dataWithoutCrc;
  }

  // Step 2: Decrypt if encrypted
  if (encrypted) {
    if (!password) {
      return { success: false, needsPassword: true, error: 'Password required for encrypted data' };
    }

    const decrypted = await decryptPayload(data, password);
    if (!decrypted) {
      return { success: false, error: 'Decryption failed - wrong password or corrupted data' };
    }
    data = decrypted;
  }

  // Step 3: Decompress if compressed
  if (compressed) {
    try {
      data = decompressPayload(data, compressionAlgo, expectedOriginalLength);
    } catch (err) {
      return {
        success: false,
        error: 'Decompression failed: ' + (err instanceof Error ? err.message : 'Unknown error')
      };
    }
  }

  return { success: true, data };
}
