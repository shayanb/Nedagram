/**
 * Nedagram CLI - Encode and decode text as audio
 */

import { Command } from 'commander';
import { encodeCommand } from './encode.js';
import { decodeCommand } from './decode.js';
import { analyzeCommand } from './analyze.js';
import { serveCommand } from './serve.js';

// Version injected at build time
declare const __VERSION__: string;
const version = typeof __VERSION__ !== 'undefined' ? __VERSION__ : '0.0.0';

const program = new Command();

program
  .name('nedagram')
  .description('Encode and decode text as audio signals.\n\nNedagram converts text into audio that can be transmitted over phone calls, voice messages, or any audio channel, then decoded back to text.')
  .version(version)
  .addHelpText('after', `
Examples:
  $ nedagram encode "Hello World" -o message.wav
  $ nedagram encode -f config.txt -o config.wav -e -p secret
  $ echo "text" | nedagram encode -o piped.wav
  $ nedagram decode message.wav
  $ nedagram decode encrypted.wav -p secret
  $ nedagram analyze recording.wav
  $ nedagram serve

For more information, visit: https://github.com/shayanb/Nedagram`);

// Encode command
program
  .command('encode')
  .description('Encode text into a WAV audio file')
  .argument('[text]', 'Text to encode (or use -f for file input, or pipe from stdin)')
  .option('-f, --file <path>', 'Read input text from a file')
  .option('-o, --output <path>', 'Output WAV file path (default: nedagram.wav or stdout if piped)')
  .option('-m, --mode <mode>', 'Audio mode: "phone" for calls/voice messages, "wideband" for direct playback', 'wideband')
  .option('-e, --encrypt', 'Encrypt the message with a password (requires -p)')
  .option('-p, --password <password>', 'Password for encryption (use with -e). Choose a strong password.')
  .option('-q, --quiet', 'Suppress progress output (only show result)')
  .option('--json', 'Output result as JSON (includes metadata, file path, sha256)')
  .addHelpText('after', `
Encryption:
  When using -e/--encrypt, you must also provide -p/--password.
  The recipient will need the same password to decode the message.
  Encryption uses ChaCha20-Poly1305 with PBKDF2 key derivation.

Audio Modes:
  phone     - Optimized for phone calls and voice codecs (slower, more robust)
  wideband  - Higher quality for direct speaker-to-mic transmission (faster)

Examples:
  $ nedagram encode "Hello World" -o hello.wav
  $ nedagram encode -f secret.txt -o secret.wav -e -p "my password"
  $ cat data.json | nedagram encode -m phone -o data.wav`)
  .action(encodeCommand);

// Decode command
program
  .command('decode')
  .description('Decode a WAV audio file back to text')
  .argument('<file>', 'WAV file to decode')
  .option('-o, --output <path>', 'Write decoded text to file instead of stdout')
  .option('-p, --password <password>', 'Password to decrypt an encrypted message')
  .option('-s, --salvage', 'Best-effort recovery with relaxed thresholds (for weak/corrupted signals)')
  .option('-q, --quiet', 'Suppress progress output (only show result)')
  .option('--json', 'Output result as JSON (includes message, metadata, sha256)')
  .addHelpText('after', `
Decryption:
  If the message was encrypted, you must provide the same password
  that was used during encoding with -p/--password.

Salvage Mode:
  Use --salvage for best-effort partial recovery from weak or corrupted
  signals. Relaxes sync thresholds and extends timeouts. Run "analyze"
  first to check signal quality.

Examples:
  $ nedagram decode message.wav
  $ nedagram decode encrypted.wav -p "my password"
  $ nedagram decode message.wav -o output.txt
  $ nedagram decode --salvage noisy-recording.wav`)
  .action(decodeCommand);

// Analyze command
program
  .command('analyze')
  .description('Analyze a WAV file for signal quality without decoding')
  .argument('<file>', 'WAV file to analyze')
  .option('--json', 'Output result as JSON')
  .addHelpText('after', `
The analyze command examines a WAV file and reports signal quality
metrics. Use this to diagnose why a decode might fail before
attempting recovery with --salvage.

Metrics reported:
  Signal Quality     - How clearly tones stand out from noise (0-100%)
  Avg Confidence     - Average tone detection confidence (0-100%)
  Symbol Error Rate  - Calibration pattern error rate (lower is better)

Examples:
  $ nedagram analyze recording.wav
  $ nedagram analyze recording.wav --json`)
  .action(analyzeCommand);

// Serve command
program
  .command('serve')
  .description('Start a local web server for the Nedagram web interface')
  .option('-p, --port <port>', 'Port to listen on (default: 8000)')
  .option('-q, --quiet', 'Only output the URL')
  .addHelpText('after', `
The serve command starts a local HTTP server that hosts the Nedagram web
interface. This allows you to use the full graphical interface in your
browser without needing an internet connection.

Examples:
  $ nedagram serve
  $ nedagram serve -p 3000
  $ nedagram serve -q`)
  .action(serveCommand);

program.parse();
