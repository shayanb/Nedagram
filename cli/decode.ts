/**
 * CLI Decode Command
 */

import { writeFileSync } from 'fs';
import { parseWavFile } from './wav-io.js';
import { Decoder } from '../src/decode/index.js';

interface DecodeOptions {
  output?: string;
  password?: string;
  quiet?: boolean;
}

export async function decodeCommand(
  filePath: string,
  options: DecodeOptions
): Promise<void> {
  const log = options.quiet ? () => {} : console.error.bind(console);

  // Suppress decoder debug logs in quiet mode
  const originalLog = console.log;
  if (options.quiet) {
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
    const result = await new Promise<{ text: string; checksum: string; stats: { originalSize: number } }>((resolve, reject) => {
      decoder.start(
        (result) => {
          resolve({
            text: result.text,
            checksum: result.checksum,
            stats: result.stats as { originalSize: number },
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

      // Feed samples in chunks
      let offset = 0;
      const processChunk = () => {
        if (offset >= samples.length) {
          // All samples processed, wait a bit for decoder to finish
          setTimeout(() => {
            const progress = decoder.progress.value;
            if (progress.state === 'error') {
              reject(new Error(progress.errorMessage || 'Decode failed'));
            } else if (progress.state !== 'complete') {
              // Still processing, check again
              setTimeout(processChunk, 100);
            }
          }, 500);
          return;
        }

        const end = Math.min(offset + chunkSize, samples.length);
        const chunk = samples.slice(offset, end);
        decoder.processSamples(chunk);

        // Log progress
        const progress = decoder.progress.value;
        const stateStr = `${progress.state} ${progress.framesReceived}/${progress.totalFrames}`;
        if (stateStr !== lastState && !options.quiet) {
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

    log('\nDecode complete!');

    // Output the decoded text
    if (options.output) {
      writeFileSync(options.output, result.text);
    } else {
      // Output to stdout
      process.stdout.write(result.text);
      // Add newline if text doesn't end with one
      if (!result.text.endsWith('\n')) {
        process.stdout.write('\n');
      }
    }

    // Final summary to stderr
    console.error('');
    console.error(`Message: ${result.stats.originalSize} bytes`);
    if (options.output) {
      console.error(`Output:  ${options.output}`);
    }
    console.error(`SHA-256: ${result.checksum}`);

  } catch (error) {
    console.error('\nError:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    // Restore console.log
    if (options.quiet) {
      console.log = originalLog;
    }
  }
}
