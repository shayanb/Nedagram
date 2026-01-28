/**
 * CLI Encode Command
 */

import { readFileSync, writeFileSync } from 'fs';
import { setAudioMode, type AudioMode } from '../src/utils/constants.js';
import { encodeString } from '../src/encode/index.js';
import { writeWavFile, createWavBuffer } from './wav-io.js';

interface EncodeOptions {
  file?: string;
  output?: string;
  mode: string;
  encrypt?: boolean;
  password?: string;
  quiet?: boolean;
}

export async function encodeCommand(
  text: string | undefined,
  options: EncodeOptions
): Promise<void> {
  const log = options.quiet ? () => {} : console.error.bind(console);

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

    // Encode
    log(`Encoding ${inputText.length} bytes...`);
    const result = await encodeString(inputText, {
      password: options.encrypt ? options.password : undefined,
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
    } else if (process.stdout.isTTY) {
      // Interactive terminal - write to default file
      outputPath = 'nedagram.wav';
      writeWavFile(outputPath, result.audio, result.sampleRate);
    } else {
      // Pipe output - write WAV to stdout
      const wavBuffer = createWavBuffer(result.audio, result.sampleRate);
      process.stdout.write(wavBuffer);
    }

    // Final summary to stderr
    console.error('');
    console.error(`Message: ${inputText.length} bytes`);
    if (outputPath) {
      console.error(`Output:  ${outputPath}`);
    }
    console.error(`SHA-256: ${result.checksum}`);

  } catch (error) {
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
