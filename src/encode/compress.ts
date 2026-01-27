/**
 * Compression utilities using pako (DEFLATE)
 */
import pako from 'pako';

/**
 * Compress data using DEFLATE algorithm
 * @param data Input bytes
 * @returns Compressed bytes
 */
export function compress(data: Uint8Array): Uint8Array {
  return pako.deflate(data, {
    level: 9, // Maximum compression
  });
}

/**
 * Decompress DEFLATE-compressed data
 * @param data Compressed bytes
 * @returns Decompressed bytes
 */
export function decompress(data: Uint8Array): Uint8Array {
  return pako.inflate(data);
}

/**
 * Try to compress data and return the smaller of original or compressed
 * @returns { data: Uint8Array, compressed: boolean }
 */
export function tryCompress(data: Uint8Array): { data: Uint8Array; compressed: boolean } {
  const compressed = compress(data);

  // Only use compression if it actually reduces size
  if (compressed.length < data.length) {
    return { data: compressed, compressed: true };
  }

  return { data, compressed: false };
}
