// Audio mode type
export type AudioMode = 'phone' | 'wideband';

// Phone-compatible mode: optimized for GSM/AMR codecs
// Based on real-world phone codec analysis:
// - Sweet spot is 800-2500 Hz (codec preserves this range best)
// - Need 500Hz+ spacing to avoid tone confusion
// - Frequencies above 2700Hz are heavily attenuated
export const PHONE_MODE = {
  SAMPLE_RATE: 48000,
  FALLBACK_SAMPLE_RATE: 44100,
  SYMBOL_DURATION_MS: 50,
  GUARD_INTERVAL_MS: 12,
  NUM_TONES: 4,               // Reduced from 8 for reliability (2 bits/symbol)
  BASE_FREQUENCY: 800,        // Start at 800Hz (codec sweet spot)
  TONE_SPACING: 500,          // Wide spacing to avoid confusion
  FREQUENCY_JITTER: 20,       // Slightly more tolerance
  WARMUP_DURATION_MS: 200,
  CHIRP_DURATION_MS: 800,
  CALIBRATION_DURATION_MS: 150,
  CALIBRATION_REPEATS: 2,
  SYNC_DURATION_MS: 100,
  CHIRP_START_HZ: 600,        // Chirp within codec range
  CHIRP_PEAK_HZ: 2600,
  CALIBRATION_TONES: [0, 1, 2, 3] as number[],  // All 4 tones for calibration
  SYNC_PATTERN: [0, 3, 0, 3, 0, 3, 0, 3] as number[],  // Low-high alternating
  BITS_PER_SYMBOL: 2,         // 4 tones = 2 bits per symbol
  // Tone frequencies: 800, 1300, 1800, 2300 Hz (all in codec sweet spot)
};

// Wideband mode: for direct device-to-device or HD Voice calls
export const WIDEBAND_MODE = {
  SAMPLE_RATE: 48000,
  FALLBACK_SAMPLE_RATE: 44100,
  SYMBOL_DURATION_MS: 40,
  GUARD_INTERVAL_MS: 5,
  NUM_TONES: 16,
  BASE_FREQUENCY: 1800,
  TONE_SPACING: 260,
  FREQUENCY_JITTER: 10,
  WARMUP_DURATION_MS: 200,       // Steady tone before chirp
  CHIRP_DURATION_MS: 800,        // Longer chirp for AGC settling
  CALIBRATION_DURATION_MS: 120,
  CALIBRATION_REPEATS: 2,        // Repeat calibration tones
  SYNC_DURATION_MS: 80,
  CHIRP_START_HZ: 1500,
  CHIRP_PEAK_HZ: 6000,
  CALIBRATION_TONES: [0, 5, 10, 15] as number[],
  SYNC_PATTERN: [0, 15, 0, 15, 0, 15, 0, 15] as number[],  // 8 symbols for reliability
  BITS_PER_SYMBOL: 4,
};

// Current audio mode - mutable object that gets updated
export const AUDIO = { ...PHONE_MODE };

// Tone frequencies - mutable array
export let TONE_FREQUENCIES: number[] = [];

// Current mode tracking
let currentMode: AudioMode = 'phone';

export function setAudioMode(mode: AudioMode): void {
  currentMode = mode;
  const settings = mode === 'phone' ? PHONE_MODE : WIDEBAND_MODE;

  // Update AUDIO object in place
  Object.assign(AUDIO, settings);

  // Update tone frequencies
  TONE_FREQUENCIES = Array.from(
    { length: settings.NUM_TONES },
    (_, i) => settings.BASE_FREQUENCY + i * settings.TONE_SPACING
  );

  console.log('[Audio] Mode set to:', mode, 'Tones:', AUDIO.NUM_TONES, 'Base freq:', AUDIO.BASE_FREQUENCY);
}

export function getAudioMode(): AudioMode {
  return currentMode;
}

// Initialize with phone mode
setAudioMode('phone');

// FEC settings - single mode with 16 parity bytes
// Corrects up to 8 byte errors per frame

// Frame structure - optimized for minimal overhead
export const FRAME = {
  // Payload sizes
  PAYLOAD_SIZE: 128,        // Max payload per frame
  MIN_PAYLOAD_SIZE: 32,     // Min payload (for small messages)

  // RS parity - 16 bytes = corrects up to 8 byte errors per frame
  RS_PARITY_SIZE: 16,

  // Header - compact format (12 bytes vs old 25)
  HEADER_SIZE: 12,

  // Magic bytes - shortened
  HEADER_MAGIC: 'N1',       // 2 bytes (was 4)
  DATA_MAGIC: 'D',          // 1 byte (was 2)

  // Version
  CURRENT_VERSION: 0x02,    // New compact version

  // Compression algorithms (in flags)
  COMPRESSION_NONE: 0,
  COMPRESSION_DEFLATE: 1,
};


// Limits
export const LIMITS = {
  MAX_PAYLOAD_BYTES: 100 * 1024, // 100KB hard limit
  SOFT_LIMIT_BYTES: 50 * 1024,   // 50KB soft limit with warning
  QR_MAX_BYTES: 2 * 1024,        // 2KB max for QR code
} as const;

// Effective bitrate calculation (phone-compatible mode):
// Symbol duration = 50ms + 12ms guard = 62ms per symbol
// 2 bits per symbol (4 tones) = ~32 bps raw
// After RS overhead: 128/144 * 32 ≈ 28 bps effective data
// Plus framing overhead, ~20-25 bps net
// Slower than before but much more reliable over GSM phone calls
