/**
 * Main encoding pipeline
 *
 * Flow: Input → Preprocess → Compress → Encrypt? → Frame → FEC → Interleave → Modulate → Audio
 */
import { stringToBytes } from '../utils/helpers';
import { AUDIO, LIMITS } from '../utils/constants';
import { tryCompress } from './compress';
import { packetize, ProtocolVersion } from './frame';
import { encodeWithFEC, calculateEncodedSize } from './fec';
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
  protocolVersion?: ProtocolVersion;  // 'v2' (default) or 'v3' (with convolutional FEC)
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
 */
export async function encodeBytes(
  data: Uint8Array,
  options?: EncodeOptions
): Promise<EncodeResult> {
  const sampleRate = options?.sampleRate ?? AUDIO.SAMPLE_RATE;
  const password = options?.password;
  const encrypted = !!password;
  const protocolVersion = options?.protocolVersion ?? 'v2';

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

  // Packetize into frames with appropriate protocol version
  const { headerFrame, dataFrames, sessionId } = packetize(
    processedData,
    data.length,
    compressed,
    encrypted,
    protocolVersion
  );

  // Add FEC to all frames (v2 or v3)
  let encodedHeader: Uint8Array;
  let encodedDataFrames: Uint8Array[];

  if (protocolVersion === 'v3') {
    // v3: Concatenated RS + Convolutional FEC with scrambling
    const v3Result = encodeWithV3FEC(headerFrame, dataFrames);
    encodedHeader = v3Result.encodedHeader;
    encodedDataFrames = v3Result.encodedDataFrames;
  } else {
    // v2: RS-only FEC
    const v2Result = encodeWithFEC(headerFrame, dataFrames);
    encodedHeader = v2Result.encodedHeader;
    encodedDataFrames = v2Result.encodedDataFrames;
  }

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
      frameCount: dataFrames.length + 1, // +1 for header
      totalEncodedBytes,
    },
  };
}

/**
 * Estimate encoding stats without performing full encode
 *
 * @param dataSize - Size of data to encode
 * @param protocolVersion - Protocol version ('v2' or 'v3')
 */
export function estimateEncode(
  dataSize: number,
  protocolVersion: ProtocolVersion = 'v2'
): {
  estimatedFrames: number;
  estimatedDuration: number;
  estimatedAudioBytes: number;
} {
  // Assume ~50% compression for typical text
  const estimatedCompressedSize = Math.floor(dataSize * 0.6);

  let dataFrames: number;
  let totalBytes: number;

  if (protocolVersion === 'v3') {
    const v3Stats = calculateV3TotalSize(estimatedCompressedSize);
    dataFrames = v3Stats.dataFrames;
    totalBytes = v3Stats.totalBytes;
  } else {
    const v2Stats = calculateEncodedSize(estimatedCompressedSize);
    dataFrames = v2Stats.dataFrames;
    totalBytes = v2Stats.totalBytes;
  }

  const estimatedDuration = calculateDuration(totalBytes, AUDIO.SAMPLE_RATE);

  // Audio bytes: 16-bit samples at 48kHz
  const estimatedAudioBytes = Math.floor(estimatedDuration * AUDIO.SAMPLE_RATE * 2);

  return {
    estimatedFrames: dataFrames + 1,
    estimatedDuration,
    estimatedAudioBytes,
  };
}
