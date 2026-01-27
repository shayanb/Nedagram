import { describe, it, expect } from 'vitest';

// Re-implement the fallback here for direct testing (same as in sha256.ts)
function sha256Fallback(data: Uint8Array): Uint8Array {
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

  let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a;
  let h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;

  const msgLen = data.length;
  const bitLen = msgLen * 8;

  // Padding: message + 0x80 + zeros + 8-byte length
  // Total must be multiple of 64 bytes (512 bits)
  const totalLen = Math.ceil((msgLen + 9) / 64) * 64;
  const padded = new Uint8Array(totalLen);
  padded.set(data);
  padded[msgLen] = 0x80;

  const view = new DataView(padded.buffer);
  view.setUint32(totalLen - 4, bitLen, false);

  const W = new Uint32Array(64);
  const rotr = (x: number, n: number) => ((x >>> n) | (x << (32 - n))) >>> 0;

  for (let offset = 0; offset < totalLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      W[i] = view.getUint32(offset + i * 4, false);
    }

    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i-15], 7) ^ rotr(W[i-15], 18) ^ (W[i-15] >>> 3);
      const s1 = rotr(W[i-2], 17) ^ rotr(W[i-2], 19) ^ (W[i-2] >>> 10);
      W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
    }

    let a = h0, b = h1, c = h2, d = h3;
    let e = h4, f = h5, g = h6, h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g; g = f; f = e;
      e = (d + temp1) >>> 0;
      d = c; c = b; b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0; h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0; h7 = (h7 + h) >>> 0;
  }

  const result = new Uint8Array(32);
  const resultView = new DataView(result.buffer);
  resultView.setUint32(0, h0, false); resultView.setUint32(4, h1, false);
  resultView.setUint32(8, h2, false); resultView.setUint32(12, h3, false);
  resultView.setUint32(16, h4, false); resultView.setUint32(20, h5, false);
  resultView.setUint32(24, h6, false); resultView.setUint32(28, h7, false);

  return result;
}

function toHex(data: Uint8Array): string {
  return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('');
}

describe('SHA-256', () => {
  // Test vectors from NIST
  it('hashes empty string correctly', () => {
    const input = new Uint8Array(0);
    const expected = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    expect(toHex(sha256Fallback(input))).toBe(expected);
  });

  it('hashes "abc" correctly', () => {
    const input = new TextEncoder().encode('abc');
    const expected = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(toHex(sha256Fallback(input))).toBe(expected);
  });

  it('hashes "hello world" correctly', () => {
    const input = new TextEncoder().encode('hello world');
    const expected = 'b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9';
    expect(toHex(sha256Fallback(input))).toBe(expected);
  });

  it('hashes longer message correctly', () => {
    // "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"
    const input = new TextEncoder().encode('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq');
    const expected = '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1';
    expect(toHex(sha256Fallback(input))).toBe(expected);
  });

  it('matches WebCrypto for random data', async () => {
    const testData = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);

    const webCryptoHash = await crypto.subtle.digest('SHA-256', testData);
    const webCryptoHex = toHex(new Uint8Array(webCryptoHash));
    const fallbackHex = toHex(sha256Fallback(testData));

    expect(fallbackHex).toBe(webCryptoHex);
  });

  it('matches WebCrypto for larger data', async () => {
    const testData = new Uint8Array(1024);
    for (let i = 0; i < testData.length; i++) {
      testData[i] = i % 256;
    }

    const webCryptoHash = await crypto.subtle.digest('SHA-256', testData);
    const webCryptoHex = toHex(new Uint8Array(webCryptoHash));
    const fallbackHex = toHex(sha256Fallback(testData));

    expect(fallbackHex).toBe(webCryptoHex);
  });
});
