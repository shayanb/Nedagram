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

