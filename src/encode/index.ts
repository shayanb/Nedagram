/**
 * Main encoding pipeline
 *
 * Flow: Input → Preprocess → Compress → Encrypt? → Frame → FEC → Interleave → Modulate → Audio
 */
import { stringToBytes } from '../utils/helpers';
import { AUDIO, LIMITS } from '../utils/constants';
import { tryCompress } from './compress';
import { packetize } from './frame';
import { encodeWithV3FEC, calculateV3TotalSize } from './v3-fec';
import { interleave, calculateInterleaverDepth } from './interleave';
import { generateTransmission, calculateDuration } from './modulate';
import { sha256Hex } from '../lib/sha256';
import { encrypt, ENCRYPTION_OVERHEAD } from '../lib/crypto';

/**
 * Preprocess text for optimal compression:
 * - Normalize line endings (CRLF/CR → LF)
 * - Remove trailing whitespace from each line
 * - Trim leading/trailing whitespace from entire text
 */
function preprocessText(text: string): string {
  return text
    // Normalize line endings to LF
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // Remove trailing whitespace from each line
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    // Trim leading/trailing whitespace from entire text
    .trim();
}

export interface EncodeResult {
  audio: Float32Array;
  sampleRate: number;
  durationSeconds: number;
  checksum: string;
  stats: {
    originalSize: number;
    compressedSize: number;
    compressed: boolean;
    encrypted: boolean;
    frameCount: number;
    totalEncodedBytes: number;
  };
}

export interface EncodeOptions {
  sampleRate?: number;
  password?: string;  // If provided, data will be encrypted
}

/**
 * Check if payload size is within limits
 */
export function checkPayloadSize(data: Uint8Array): {
  valid: boolean;
  warning: boolean;
  message?: string;
} {
  if (data.length > LIMITS.MAX_PAYLOAD_BYTES) {
    return {
      valid: false,
      warning: false,
      message: `Payload exceeds maximum size (${LIMITS.MAX_PAYLOAD_BYTES / 1024}KB)`,
    };
  }

  if (data.length > LIMITS.SOFT_LIMIT_BYTES) {
    return {
      valid: true,
      warning: true,
      message: `Large payload - transmission may take several minutes`,
    };
  }

  return { valid: true, warning: false };
}

/**
 * Encode string data to audio
 */
export async function encodeString(
  text: string,
  options?: EncodeOptions
): Promise<EncodeResult> {
  // Preprocess text for optimal compression
  const processed = preprocessText(text);
  const data = stringToBytes(processed);
  return encodeBytes(data, options);
}

/**
 * Encode binary data to audio
 *
 * Uses v3 protocol with concatenated RS + Convolutional FEC
 */
export async function encodeBytes(
  data: Uint8Array,
  options?: EncodeOptions
): Promise<EncodeResult> {
  const sampleRate = options?.sampleRate ?? AUDIO.SAMPLE_RATE;
  const password = options?.password;
  const encrypted = !!password;

  // Check size limits (account for encryption overhead if needed)
  const effectiveSize = encrypted ? data.length + ENCRYPTION_OVERHEAD : data.length;
  const sizeCheck = checkPayloadSize(new Uint8Array(effectiveSize));
  if (!sizeCheck.valid) {
    throw new Error(sizeCheck.message);
  }

  // Calculate checksum of original data (before encryption)
  const checksum = await sha256Hex(data);

  // Try compression first
  const { data: maybeCompressed, compressed } = tryCompress(data);

  // Encrypt if password provided (after compression, before framing)
  let processedData = maybeCompressed;
  if (encrypted) {
    processedData = await encrypt(maybeCompressed, password);
  }

  // Packetize into frames with v3 protocol
  const { headerFrame, dataFrames, sessionId } = packetize(
    processedData,
    data.length,
    compressed,
    encrypted,
    'v3'
  );

  // Add v3 FEC to all frames (RS + Scramble + Convolutional)
  const { encodedHeader, encodedDataFrames } = encodeWithV3FEC(headerFrame, dataFrames);

  // Interleave each frame for burst error protection
  // This spreads adjacent bytes across the frame, so burst errors
  // (consecutive corrupted symbols) are spread out and more likely
  // to be correctable by RS/Viterbi decoding
  const interleavedHeader = interleave(encodedHeader, calculateInterleaverDepth(encodedHeader.length));
  const interleavedDataFrames = encodedDataFrames.map(frame =>
    interleave(frame, calculateInterleaverDepth(frame.length))
  );

  // Combine all encoded frames (header first, then data)
  const allEncodedFrames = [interleavedHeader, ...interleavedDataFrames];

  // Calculate total encoded bytes
  const totalEncodedBytes = allEncodedFrames.reduce((sum, f) => sum + f.length, 0);

  // Generate audio
  const audio = generateTransmission(allEncodedFrames, sampleRate);

  // Calculate duration
  const durationSeconds = audio.length / sampleRate;

  return {
    audio,
    sampleRate,
    durationSeconds,
    checksum,
    stats: {
      originalSize: data.length,
      compressedSize: processedData.length,
      compressed,
      encrypted,
      frameCount: dataFrames.length,
      totalEncodedBytes,
    },
  };
}

/**
 * Estimate encoding stats without performing full encode
 *
 * Uses v3 protocol sizing (RS + Convolutional FEC)
 * If data is provided, uses actual compression for accurate estimate
 */
export function estimateEncode(dataSize: number, data?: Uint8Array): {
  estimatedFrames: number;
  estimatedDuration: number;
  estimatedAudioBytes: number;
} {
  let estimatedCompressedSize: number;

  if (data) {
    // Use actual compression for accurate estimate
    const { data: compressed, compressed: wasCompressed } = tryCompress(data);
    estimatedCompressedSize = wasCompressed ? compressed.length : data.length;
  } else {
    // Fallback: assume ~40% compression for typical text (conservative)
    estimatedCompressedSize = Math.floor(dataSize * 0.6);
  }

  const v3Stats = calculateV3TotalSize(estimatedCompressedSize);
  const { dataFrames, totalBytes } = v3Stats;

  const estimatedDuration = calculateDuration(totalBytes, AUDIO.SAMPLE_RATE);

  // Audio bytes: 16-bit samples at 48kHz
  const estimatedAudioBytes = Math.floor(estimatedDuration * AUDIO.SAMPLE_RATE * 2);

  return {
    estimatedFrames: dataFrames,
    estimatedDuration,
    estimatedAudioBytes,
  };
}
