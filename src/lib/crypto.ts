/**
 * Encryption module using ChaCha20-Poly1305 with PBKDF2 key derivation
 */
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

// Constants
const SALT_SIZE = 16;
const NONCE_SIZE = 12;
const KEY_SIZE = 32;
const PBKDF2_ITERATIONS = 100000;

/**
 * Generate cryptographically secure random bytes
 */
function getRandomBytes(size: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(size));
}

/**
 * Derive encryption key from password using PBKDF2
 */
async function deriveKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const encoder = new TextEncoder();
  const passwordBytes = encoder.encode(password);

  // Import password as key material
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBytes,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  // Derive key bits
  const keyBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt as unknown as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    KEY_SIZE * 8
  );

  return new Uint8Array(keyBits);
}

/**
 * Encrypt data with password
 * Output format: salt (16) + nonce (12) + ciphertext + tag (16)
 */
export async function encrypt(data: Uint8Array, password: string): Promise<Uint8Array> {
  // Generate random salt and nonce
  const salt = getRandomBytes(SALT_SIZE);
  const nonce = getRandomBytes(NONCE_SIZE);

  // Derive key from password
  const key = await deriveKey(password, salt);

  // Encrypt using ChaCha20-Poly1305
  const cipher = chacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(data);

  // Combine: salt + nonce + ciphertext (includes auth tag)
  const result = new Uint8Array(SALT_SIZE + NONCE_SIZE + ciphertext.length);
  result.set(salt, 0);
  result.set(nonce, SALT_SIZE);
  result.set(ciphertext, SALT_SIZE + NONCE_SIZE);

  return result;
}

/**
 * Decrypt data with password
 * Returns null if decryption fails (wrong password or corrupted data)
 */
export async function decrypt(encryptedData: Uint8Array, password: string): Promise<Uint8Array | null> {
  if (encryptedData.length < SALT_SIZE + NONCE_SIZE + 16) {
    // Too short to be valid (need at least salt + nonce + auth tag)
    return null;
  }

  try {
    // Extract salt, nonce, and ciphertext
    const salt = encryptedData.slice(0, SALT_SIZE);
    const nonce = encryptedData.slice(SALT_SIZE, SALT_SIZE + NONCE_SIZE);
    const ciphertext = encryptedData.slice(SALT_SIZE + NONCE_SIZE);

    // Derive key from password
    const key = await deriveKey(password, salt);

    // Decrypt using ChaCha20-Poly1305
    const cipher = chacha20poly1305(key, nonce);
    const plaintext = cipher.decrypt(ciphertext);

    return plaintext;
  } catch {
    // Decryption failed (wrong password or corrupted data)
    return null;
  }
}

/**
 * Calculate password strength (0-4)
 * 0: Very weak, 1: Weak, 2: Fair, 3: Strong, 4: Very strong
 */
export function calculatePasswordStrength(password: string): number {
  if (!password) return 0;

  let score = 0;

  // Length checks
  if (password.length >= 8) score++;
  if (password.length >= 12) score++;
  if (password.length >= 16) score++;

  // Character variety
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) score++;
  if (/\d/.test(password)) score++;
  if (/[^a-zA-Z0-9]/.test(password)) score++;

  // Cap at 4
  return Math.min(score, 4);
}

/**
 * Get password strength label
 */
export function getPasswordStrengthLabel(strength: number): string {
  switch (strength) {
    case 0: return 'weak';
    case 1: return 'weak';
    case 2: return 'fair';
    case 3: return 'strong';
    case 4: return 'strong';
    default: return 'weak';
  }
}

// Overhead added by encryption (salt + nonce + auth tag)
export const ENCRYPTION_OVERHEAD = SALT_SIZE + NONCE_SIZE + 16; // 44 bytes
