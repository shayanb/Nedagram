/**
 * SHA-256 implementation with WebCrypto and pure JS fallback
 * Fallback is needed for non-secure contexts (HTTP on non-localhost)
 */

// Check if we're in a secure context where crypto.subtle is available
const isSecureContext = typeof crypto !== 'undefined' &&
  typeof crypto.subtle !== 'undefined' &&
  typeof crypto.subtle.digest === 'function';

/**
 * Pure JavaScript SHA-256 implementation (fallback for non-secure contexts)
 */
function sha256Fallback(data: Uint8Array): Uint8Array {
  // SHA-256 constants
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  // Initial hash values
  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  // Pre-processing: adding padding bits
  const msgLen = data.length;
  const bitLen = msgLen * 8;

  // Padding: message + 0x80 + zeros + 8-byte length
  // Total must be multiple of 64 bytes (512 bits)
  // We need: msgLen + 1 + padding + 8 ≡ 0 (mod 64)
  const totalLen = Math.ceil((msgLen + 9) / 64) * 64;
  const padded = new Uint8Array(totalLen);
  padded.set(data);
  padded[msgLen] = 0x80;

  // Append length in bits as 64-bit big-endian (only lower 32 bits for messages < 512MB)
  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 4, bitLen, false);

  // Process each 512-bit (64-byte) block
  const W = new Uint32Array(64);

  for (let offset = 0; offset < totalLen; offset += 64) {
    // Copy block into W[0..15]
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(offset + i * 4, false);
    }

    // Extend W[16..63]
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i-15], 7) ^ rotr(W[i-15], 18) ^ (W[i-15] >>> 3);
      const s1 = rotr(W[i-2], 17) ^ rotr(W[i-2], 19) ^ (W[i-2] >>> 10);
      W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
    }

    // Initialize working variables
    let a = h0, b = h1, c = h2, d = h3;
    let e = h4, f = h5, g = h6, h = h7;

    // Main loop
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    // Add to hash
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  // Produce final hash
  const result = new Uint8Array(32);
  const resultView = new DataView(result.buffer);
  resultView.setUint32(0, h0, false);
  resultView.setUint32(4, h1, false);
  resultView.setUint32(8, h2, false);
  resultView.setUint32(12, h3, false);
  resultView.setUint32(16, h4, false);
  resultView.setUint32(20, h5, false);
  resultView.setUint32(24, h6, false);
  resultView.setUint32(28, h7, false);

  return result;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/**
 * Calculate SHA-256 hash of data
 * @param data Input bytes
 * @returns SHA-256 hash as Uint8Array (32 bytes)
 */
export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  if (isSecureContext) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data as unknown as BufferSource);
    return new Uint8Array(hashBuffer);
  }
  // Fallback for non-secure contexts
  return sha256Fallback(data);
}

/**
 * Calculate SHA-256 hash and return as hex string
 */
export async function sha256Hex(data: Uint8Array): Promise<string> {
  const hash = await sha256(data);
  return Array.from(hash)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Calculate SHA-256 hash of a string (UTF-8 encoded)
 */
export async function sha256String(str: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(str);
  return sha256Hex(data);
}
