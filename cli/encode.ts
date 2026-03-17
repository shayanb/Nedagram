/**
 * CLI Encode Command
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { setAudioMode, AUDIO, type AudioMode } from '../src/utils/constants.js';
import { encodeString } from '../src/encode/index.js';
import { writeWavFile, createWavBuffer, readWavFile } from './wav-io.js';

interface EncodeOptions {
  file?: string;
  output?: string;
  mode: string;
  encrypt?: boolean;
  password?: string;
  quiet?: boolean;
  json?: boolean;
  music?: string;
  tmr?: string;
}

interface EncodeResult {
  success: boolean;
  bytes: number;
  sha256: string;
  output?: string;
  duration: number;
  frames: number;
  mode: string;
  encrypted: boolean;
  compressed: boolean;
}

/**
 * Load a music file (MP3/WAV/etc) as mono Float32Array at target sample rate.
 * Uses ffmpeg for format conversion.
 */
function loadMusicFile(path: string, sampleRate: number): Float32Array {
  const tmpPath = '/tmp/nedagram-music-tmp.wav';
  try {
    execSync(
      `ffmpeg -y -i "${path}" -ar ${sampleRate} -ac 1 -c:a pcm_s16le "${tmpPath}" 2>/dev/null`,
      { stdio: ['pipe', 'pipe', 'pipe'] }
    );
  } catch {
    throw new Error(`Failed to load music file: ${path}. Ensure ffmpeg is installed.`);
  }
  return readWavFile(tmpPath);
}

export async function encodeCommand(
  text: string | undefined,
  options: EncodeOptions
): Promise<void> {
  const log = options.quiet || options.json ? () => {} : console.error.bind(console);

  try {
    // Get input text
    let inputText: string;

    if (options.file) {
      // Read from file
      log(`Reading from ${options.file}...`);
      inputText = readFileSync(options.file, 'utf-8');
    } else if (text) {
      // Use provided text argument
      inputText = text;
    } else if (!process.stdin.isTTY) {
      // Read from stdin (piped input)
      log('Reading from stdin...');
      inputText = readFileSync(0, 'utf-8');
    } else {
      console.error('Error: No input provided. Use text argument, -f flag, or pipe input.');
      process.exit(1);
    }

    if (!inputText.trim()) {
      console.error('Error: Input text is empty.');
      process.exit(1);
    }

    // Set audio mode
    const mode = options.mode.toLowerCase() as AudioMode;
    if (mode !== 'phone' && mode !== 'wideband') {
      console.error('Error: Invalid mode. Use "phone" or "wideband".');
      process.exit(1);
    }
    setAudioMode(mode);
    log(`Mode: ${mode}`);

    // Validate encryption options
    if (options.encrypt && !options.password) {
      console.error('Error: Password required for encryption. Use -p flag.');
      process.exit(1);
    }

    // Load cover music if --music flag provided
    let musicSamples: Float32Array | undefined;
    if (options.music) {
      log(`Loading cover music: ${options.music}`);
      musicSamples = loadMusicFile(options.music, AUDIO.SAMPLE_RATE);
      log(`Music: ${(musicSamples.length / AUDIO.SAMPLE_RATE).toFixed(1)}s`);
    }

    const tmrDb = options.tmr ? parseFloat(options.tmr) : undefined;

    // Encode
    log(`Encoding ${inputText.length} bytes...`);
    const result = await encodeString(inputText, {
      password: options.encrypt ? options.password : undefined,
      musicSamples,
      tmrDb,
    });

    log(`Duration: ${result.durationSeconds.toFixed(1)}s`);
    log(`Frames: ${result.stats.frameCount}`);
    log(`Compressed: ${result.stats.compressed ? 'yes' : 'no'}`);
    log(`Encrypted: ${result.stats.encrypted ? 'yes' : 'no'}`);

    // Output
    let outputPath: string | null = null;
    if (options.output) {
      // Write to file
      writeWavFile(options.output, result.audio, result.sampleRate);
      outputPath = options.output;
    } else if (process.stdout.isTTY || options.json) {
      // Interactive terminal or JSON mode - write to default file
      outputPath = 'nedagram.wav';
      writeWavFile(outputPath, result.audio, result.sampleRate);
    } else {
      // Pipe output - write WAV to stdout
      const wavBuffer = createWavBuffer(result.audio, result.sampleRate);
      process.stdout.write(wavBuffer);
    }

    // JSON output mode
    if (options.json) {
      const jsonResult: EncodeResult = {
        success: true,
        bytes: inputText.length,
        sha256: result.checksum,
        duration: result.durationSeconds,
        frames: result.stats.frameCount,
        mode: mode,
        encrypted: result.stats.encrypted,
        compressed: result.stats.compressed,
      };
      if (outputPath) {
        jsonResult.output = outputPath;
      }
      console.log(JSON.stringify(jsonResult, null, 2));
      return;
    }

    // Final summary to stderr
    console.error('');
    console.error(`Message: ${inputText.length} bytes`);
    if (outputPath) {
      console.error(`Output:  ${outputPath}`);
    }
    console.error(`SHA-256: ${result.checksum}`);

  } catch (error) {
    if (options.json) {
      const jsonResult = {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
      console.log(JSON.stringify(jsonResult, null, 2));
      process.exit(1);
    }
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
