import { describe, it, expect } from 'vitest';
import { crc32, crc32Bytes, verifyCRC32 } from '../src/lib/crc32';

describe('CRC32', () => {
  it('should compute correct CRC32 for empty data', () => {
    const data = new Uint8Array(0);
    expect(crc32(data)).toBe(0x00000000);
  });

  it('should compute correct CRC32 for "123456789"', () => {
    // Standard test vector: CRC32 of "123456789" should be 0xCBF43926
    const data = new TextEncoder().encode('123456789');
    expect(crc32(data)).toBe(0xCBF43926);
  });

  it('should compute correct CRC32 for various inputs', () => {
    const testCases: [string, number][] = [
      ['', 0x00000000],
      ['a', 0xE8B7BE43],
      ['abc', 0x352441C2],
      ['hello', 0x3610A686],
    ];

    for (const [input, expected] of testCases) {
      const data = new TextEncoder().encode(input);
      expect(crc32(data)).toBe(expected);
    }
  });

  it('should return bytes in little-endian order', () => {
    const data = new TextEncoder().encode('123456789');
    const bytes = crc32Bytes(data);

    expect(bytes.length).toBe(4);
    // 0xCBF43926 in little-endian
    expect(bytes[0]).toBe(0x26);
    expect(bytes[1]).toBe(0x39);
    expect(bytes[2]).toBe(0xF4);
    expect(bytes[3]).toBe(0xCB);
  });

  it('should verify CRC32 correctly', () => {
    const data = new TextEncoder().encode('test data');
    const checksum = crc32(data);

    expect(verifyCRC32(data, checksum)).toBe(true);
    expect(verifyCRC32(data, checksum + 1)).toBe(false);
  });
});
