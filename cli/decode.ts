/**
 * CLI Decode Command
 */

import { writeFileSync } from 'fs';
import { parseWavFile } from './wav-io.js';
import { Decoder } from '../src/decode/index.js';

interface DecodeOptions {
  output?: string;
  password?: string;
  salvage?: boolean;
  quiet?: boolean;
  json?: boolean;
}

interface DecodeResult {
  success: boolean;
  message: string;
  bytes: number;
  sha256: string;
  output?: string;
  encrypted: boolean;
  compressed: boolean;
}

export async function decodeCommand(
  filePath: string,
  options: DecodeOptions
): Promise<void> {
  const log = options.quiet || options.json ? () => {} : console.error.bind(console);

  // Suppress decoder debug logs in quiet mode or json mode
  const originalLog = console.log;
  if (options.quiet || options.json) {
    console.log = (...args: unknown[]) => {
      const msg = args[0];
      if (typeof msg === 'string' && (msg.startsWith('[Decoder]') || msg.startsWith('[ChirpDetector]') || msg.startsWith('[Audio]'))) {
        return; // Suppress decoder debug logs
      }
      originalLog.apply(console, args);
    };
  }

  try {
    // Parse WAV file
    log(`Reading ${filePath}...`);
    const { samples, sampleRate } = parseWavFile(filePath);
    log(`Sample rate: ${sampleRate} Hz, Duration: ${(samples.length / sampleRate).toFixed(1)}s`);

    // Create decoder
    const decoder = new Decoder(sampleRate);

    // Process in chunks to simulate streaming and allow progress updates
    const chunkSize = Math.floor(sampleRate * 0.1); // 100ms chunks
    let lastState = '';

    // Wrap in promise for async completion
    const result = await new Promise<{ text: string; checksum: string; encrypted: boolean; needsPassword?: boolean; stats: { originalSize: number; compressed: boolean } }>((resolve, reject) => {
      decoder.start(
        (result) => {
          resolve({
            text: result.text,
            checksum: result.checksum,
            encrypted: result.encrypted,
            needsPassword: result.needsPassword,
            stats: result.stats as { originalSize: number; compressed: boolean },
          });
        },
        (error) => {
          reject(error);
        }
      );

      // Set password after start() since start() calls reset() which clears it
      if (options.password) {
        decoder.setPassword(options.password);
      }

      // Enable salvage mode for best-effort recovery
      if (options.salvage) {
        decoder.setSalvageMode(true);
        log('Salvage mode enabled: relaxed thresholds, extended timeouts');
      }

      // Feed samples in chunks
      let offset = 0;
      let postFeedPolls = 0;
      const MAX_POST_FEED_POLLS = 30; // 3 seconds max after all samples fed

      const processChunk = () => {
        if (offset >= samples.length) {
          // All samples processed - poll for completion with a hard limit
          postFeedPolls++;
          const progress = decoder.progress.value;

          if (progress.state === 'error') {
            reject(new Error(progress.errorMessage || 'Decode failed'));
            return;
          }
          if (progress.state === 'complete') {
            return; // resolve was already called by decoder callback
          }
          if (postFeedPolls >= MAX_POST_FEED_POLLS) {
            const state = progress.state;
            let msg: string;
            if (state === 'receiving_data') {
              msg = `Decode failed: header OK but data frame incomplete (${progress.framesReceived}/${progress.totalFrames} frames). ` +
                'Recording may be too short or signal too distorted.';
            } else if (state === 'receiving_header') {
              msg = progress.errorMessage
                ? `Decode failed: ${progress.errorMessage}`
                : 'Decode failed: could not decode header. Signal may be too distorted. Try: nedagram analyze <file>';
            } else {
              msg = 'Decode failed: could not recover signal from audio. Try: nedagram analyze <file>';
            }
            reject(new Error(msg));
            return;
          }

          setTimeout(processChunk, 100);
          return;
        }

        const end = Math.min(offset + chunkSize, samples.length);
        const chunk = samples.slice(offset, end);
        decoder.processSamples(chunk);

        // Log progress
        const progress = decoder.progress.value;
        const stateStr = `${progress.state} ${progress.framesReceived}/${progress.totalFrames}`;
        if (stateStr !== lastState && !options.quiet && !options.json) {
          if (progress.state === 'detecting_preamble') {
            process.stderr.write('\rDetecting preamble...');
          } else if (progress.state === 'receiving_header') {
            process.stderr.write('\rReceiving header...   ');
          } else if (progress.state === 'receiving_data') {
            process.stderr.write(`\rReceiving: ${progress.framesReceived}/${progress.totalFrames} frames`);
          }
          lastState = stateStr;
        }

        offset = end;

        // Check if complete or error
        if (progress.state === 'complete' || progress.state === 'error') {
          return;
        }

        // Process next chunk
        setImmediate(processChunk);
      };

      processChunk();
    });

    // Handle encrypted files that need a password
    if (result.needsPassword) {
      if (options.json) {
        console.log(JSON.stringify({
          success: false,
          encrypted: true,
          error: 'Encrypted file requires a password. Use -p <password> to decrypt.',
          bytes: result.stats.originalSize,
        }, null, 2));
        process.exit(1);
      }
      console.error('\nThis file is encrypted.');
      console.error('Use -p <password> to decrypt:');
      console.error(`  nedagram decode -p <password> "${filePath}"`);
      process.exit(1);
    }

    // JSON output mode
    if (options.json) {
      const jsonResult: DecodeResult = {
        success: true,
        message: result.text,
        bytes: result.stats.originalSize,
        sha256: result.checksum,
        encrypted: result.encrypted,
        compressed: result.stats.compressed,
      };
      if (options.output) {
        jsonResult.output = options.output;
        writeFileSync(options.output, result.text);
      }
      console.log(JSON.stringify(jsonResult, null, 2));
      return;
    }

    log('\nDecode complete!');
    log('');
    log('────────────────────────────────────────');

    // Output the decoded text
    if (options.output) {
      writeFileSync(options.output, result.text);
      // Show message content in the summary area
      console.error(result.text);
      if (!result.text.endsWith('\n')) {
        console.error('');
      }
    } else {
      // Output to stdout
      process.stdout.write(result.text);
      // Add newline if text doesn't end with one
      if (!result.text.endsWith('\n')) {
        process.stdout.write('\n');
      }
    }

    // Final summary to stderr
    console.error('────────────────────────────────────────');
    console.error(`Message: ${result.stats.originalSize} bytes`);
    if (options.output) {
      console.error(`Output:  ${options.output}`);
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
    console.error('\nError:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    // Restore console.log
    if (options.quiet || options.json) {
      console.log = originalLog;
    }
  }
}
