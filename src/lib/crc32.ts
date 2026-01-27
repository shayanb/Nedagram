/**
 * CRC32 implementation (IEEE polynomial)
 */

// Pre-computed CRC32 table
const CRC32_TABLE = new Uint32Array(256);

// Initialize table
(function initCRC32Table() {
  const polynomial = 0xEDB88320;

  for (let i = 0; i < 256; i++) {
    let crc = i;
    for (let j = 0; j < 8; j++) {
      if (crc & 1) {
        crc = (crc >>> 1) ^ polynomial;
      } else {
        crc >>>= 1;
      }
    }
    CRC32_TABLE[i] = crc >>> 0;
  }
})();

/**
 * Calculate CRC32 checksum of data
 * @param data Input bytes
 * @param initial Optional initial CRC value (for continuing a previous calculation)
 * @returns CRC32 checksum as unsigned 32-bit integer
 */
export function crc32(data: Uint8Array, initial = 0xFFFFFFFF): number {
  let crc = initial;

  for (let i = 0; i < data.length; i++) {
    const byte = data[i];
    const tableIndex = (crc ^ byte) & 0xFF;
    crc = (crc >>> 8) ^ CRC32_TABLE[tableIndex];
  }

  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/**
 * Calculate CRC32 and return as 4-byte Uint8Array (little-endian)
 */
export function crc32Bytes(data: Uint8Array): Uint8Array {
  const checksum = crc32(data);
  const result = new Uint8Array(4);
  result[0] = checksum & 0xFF;
  result[1] = (checksum >> 8) & 0xFF;
  result[2] = (checksum >> 16) & 0xFF;
  result[3] = (checksum >> 24) & 0xFF;
  return result;
}

/**
 * Verify CRC32 checksum
 */
export function verifyCRC32(data: Uint8Array, expectedCRC: number): boolean {
  return crc32(data) === expectedCRC;
}
