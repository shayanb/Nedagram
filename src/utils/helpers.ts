/**
 * Convert a UTF-8 string to Uint8Array
 */
export function stringToBytes(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

/**
 * Convert a Uint8Array to UTF-8 string
 */
export function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

/**
 * Convert bytes to hex string
 */
export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Convert hex string to bytes
 */
export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Generate a random session ID (4 bytes)
 */
export function generateSessionId(): number {
  return Math.floor(Math.random() * 0xFFFFFFFF);
}

/**
 * Read a 16-bit little-endian unsigned integer from buffer
 */
export function readUint16LE(buffer: Uint8Array, offset: number): number {
  return buffer[offset] | (buffer[offset + 1] << 8);
}

/**
 * Write a 16-bit little-endian unsigned integer to buffer
 */
export function writeUint16LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xFF;
  buffer[offset + 1] = (value >> 8) & 0xFF;
}

/**
 * Read a 32-bit little-endian unsigned integer from buffer
 */
export function readUint32LE(buffer: Uint8Array, offset: number): number {
  return (
    (buffer[offset] |
    (buffer[offset + 1] << 8) |
    (buffer[offset + 2] << 16) |
    (buffer[offset + 3] << 24)) >>> 0
  );
}

/**
 * Write a 32-bit little-endian unsigned integer to buffer
 */
export function writeUint32LE(buffer: Uint8Array, offset: number, value: number): void {
  buffer[offset] = value & 0xFF;
  buffer[offset + 1] = (value >> 8) & 0xFF;
  buffer[offset + 2] = (value >> 16) & 0xFF;
  buffer[offset + 3] = (value >> 24) & 0xFF;
}

/**
 * Format bytes as human-readable size
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Format duration in seconds as mm:ss
 */
export function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

/**
 * Delay for a given number of milliseconds
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Concatenate multiple Uint8Arrays
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
