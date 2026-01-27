/**
 * Decompression and decryption utilities
 */
import { decompress as pakoDecompress } from '../encode/compress';
import { FRAME } from '../utils/constants';
import { decrypt } from '../lib/crypto';

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
 * Process received payload: decrypt (if needed) then decompress
 * Order: Decrypt → Decompress (reverse of encode order)
 */
export async function processPayload(
  payload: Uint8Array,
  encrypted: boolean,
  compressed: boolean,
  compressionAlgo: number,
  expectedOriginalLength: number,
  password?: string
): Promise<ProcessResult> {
  let data = payload;

  // Step 1: Decrypt if encrypted
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

  // Step 2: Decompress if compressed
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
