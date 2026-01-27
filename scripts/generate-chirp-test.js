/**
 * Chirp Test Signal Generator for Phone Line Testing
 *
 * Usage: node scripts/generate-chirp-test.js
 * Output: public/chirp-test.wav
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SAMPLE_RATE = 48000;
const BITS_PER_SAMPLE = 16;

// Generate a sine wave
function generateTone(frequency, duration, amplitude = 0.7) {
  const samples = Math.floor(SAMPLE_RATE * duration);
  const result = [];
  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    result.push(amplitude * Math.sin(2 * Math.PI * frequency * t));
  }
  return result;
}

// Generate a linear chirp (frequency sweep)
function generateChirp(startFreq, endFreq, duration, amplitude = 0.7) {
  const samples = Math.floor(SAMPLE_RATE * duration);
  const result = [];
  const freqRate = (endFreq - startFreq) / duration;

  for (let i = 0; i < samples; i++) {
    const t = i / SAMPLE_RATE;
    const phase = 2 * Math.PI * (startFreq * t + freqRate * t * t / 2);
    result.push(amplitude * Math.sin(phase));
  }
  return result;
}

// Generate silence
function generateSilence(duration) {
  const samples = Math.floor(SAMPLE_RATE * duration);
  return new Array(samples).fill(0);
}

// Apply fade in/out to avoid clicks
function applyFade(samples, fadeMs = 10) {
  const fadeSamples = Math.floor(SAMPLE_RATE * fadeMs / 1000);
  const result = [...samples];

  for (let i = 0; i < fadeSamples && i < result.length; i++) {
    const factor = i / fadeSamples;
    result[i] *= factor;
    result[result.length - 1 - i] *= factor;
  }

  return result;
}

// Current Nedagram phone mode tones
const PHONE_TONES = [600, 950, 1300, 1650, 2000, 2350, 2700, 3050];

// Wider-spaced tones (500 Hz spacing)
const WIDE_TONES = [700, 1200, 1700, 2200, 2700];

// Build the test signal
function buildTestSignal() {
  const segments = [];

  // 1. Reference tone (1000 Hz) - 2 seconds
  console.log('Adding: Reference tone 1000 Hz (0:00-0:02)');
  segments.push({
    name: 'Reference 1000Hz',
    samples: applyFade(generateTone(1000, 2.0))
  });

  // 2. Chirp up (600→2800 Hz) - 2 seconds
  console.log('Adding: Chirp UP 600→2800 Hz (0:02-0:04)');
  segments.push({
    name: 'Chirp UP',
    samples: applyFade(generateChirp(600, 2800, 2.0))
  });

  // 3. Chirp down (2800→600 Hz) - 2 seconds
  console.log('Adding: Chirp DOWN 2800→600 Hz (0:04-0:06)');
  segments.push({
    name: 'Chirp DOWN',
    samples: applyFade(generateChirp(2800, 600, 2.0))
  });

  // 4. Current MFSK tones - 0.5s each = 4 seconds
  console.log('Adding: Current MFSK tones (0:06-0:10)');
  for (const freq of PHONE_TONES) {
    segments.push({
      name: `MFSK tone ${freq}Hz`,
      samples: applyFade(generateTone(freq, 0.5))
    });
  }

  // 5. Wider-spaced tones - 0.5s each = 2.5 seconds
  console.log('Adding: Wide-spaced tones (0:10-0:12.5)');
  for (const freq of WIDE_TONES) {
    segments.push({
      name: `Wide tone ${freq}Hz`,
      samples: applyFade(generateTone(freq, 0.5))
    });
  }

  // 6. Short chirps for data encoding test - 4 seconds
  console.log('Adding: Short chirps for data test (0:12.5-0:16.5)');
  const chirpDuration = 0.1; // 100ms per symbol
  const testPattern = [
    { start: 600, end: 1700 },   // 00 - sub1 up
    { start: 1700, end: 600 },   // 01 - sub1 down
    { start: 1700, end: 2800 },  // 10 - sub2 up
    { start: 2800, end: 1700 },  // 11 - sub2 down
  ];

  // Repeat pattern 10 times
  for (let rep = 0; rep < 10; rep++) {
    for (const chirp of testPattern) {
      segments.push({
        name: `Data chirp ${chirp.start}→${chirp.end}`,
        samples: applyFade(generateChirp(chirp.start, chirp.end, chirpDuration), 5)
      });
    }
  }

  // 7. Silence test (to check VAD behavior) - 2 seconds
  console.log('Adding: Silence for VAD test (0:16.5-0:18.5)');
  segments.push({
    name: 'Silence',
    samples: generateSilence(2.0)
  });

  // 8. Low amplitude chirps - 2 seconds
  console.log('Adding: Low amplitude chirps (0:18.5-0:20.5)');
  segments.push({
    name: 'Low amp chirp UP',
    samples: applyFade(generateChirp(600, 2800, 1.0, 0.3))
  });
  segments.push({
    name: 'Low amp chirp DOWN',
    samples: applyFade(generateChirp(2800, 600, 1.0, 0.3))
  });

  // 9. Rapid alternating tones (stress test) - 2 seconds
  console.log('Adding: Rapid alternating tones (0:20.5-0:22.5)');
  const rapidTones = [];
  const toneLength = 0.05; // 50ms per tone
  for (let i = 0; i < 40; i++) {
    const freq = i % 2 === 0 ? 800 : 2400;
    rapidTones.push(...applyFade(generateTone(freq, toneLength), 3));
  }
  segments.push({
    name: 'Rapid alternating',
    samples: rapidTones
  });

  // 10. Final reference tone - 2 seconds
  console.log('Adding: Final reference tone 1500 Hz (0:22.5-0:24.5)');
  segments.push({
    name: 'Final reference 1500Hz',
    samples: applyFade(generateTone(1500, 2.0))
  });

  // Concatenate all segments with small gaps
  const gap = generateSilence(0.1);
  const allSamples = [];

  for (const segment of segments) {
    allSamples.push(...segment.samples);
    allSamples.push(...gap);
  }

  console.log(`\nTotal duration: ${(allSamples.length / SAMPLE_RATE).toFixed(1)} seconds`);
  console.log(`Total samples: ${allSamples.length}`);

  return allSamples;
}

// Convert samples to WAV format
function samplesToWav(samples) {
  const numChannels = 1;
  const bytesPerSample = BITS_PER_SAMPLE / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const fileSize = 44 + dataSize;

  const buffer = Buffer.alloc(fileSize);

  // WAV header
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(fileSize - 8, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16); // fmt chunk size
  buffer.writeUInt16LE(1, 20);  // PCM format
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(BITS_PER_SAMPLE, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);

  // Write samples
  let offset = 44;
  for (const sample of samples) {
    const clamped = Math.max(-1, Math.min(1, sample));
    const int16 = Math.floor(clamped * 32767);
    buffer.writeInt16LE(int16, offset);
    offset += 2;
  }

  return buffer;
}

// Main
function main() {
  console.log('=== Chirp Test Signal Generator ===\n');
  console.log('Generating test signal for phone line evaluation...\n');

  const samples = buildTestSignal();
  const wavData = samplesToWav(samples);

  const outputPath = path.join(__dirname, '..', 'public', 'chirp-test.wav');
  fs.writeFileSync(outputPath, wavData);

  console.log(`\nWAV file written to: ${outputPath}`);
  console.log('\n=== Test Instructions ===');
  console.log('1. Start dev server: npm run dev');
  console.log('2. Access: https://localhost:5173/chirp-test.wav');
  console.log('3. Person A: Play this file over phone speaker during call');
  console.log('4. Person B: Record the received audio on their device');
  console.log('5. Share the recorded file for analysis');
  console.log('\n=== Signal Timeline ===');
  console.log('0:00-0:02  Reference tone 1000 Hz');
  console.log('0:02-0:04  Chirp UP 600→2800 Hz');
  console.log('0:04-0:06  Chirp DOWN 2800→600 Hz');
  console.log('0:06-0:10  Current MFSK tones (8 tones)');
  console.log('0:10-0:12  Wide-spaced tones (5 tones)');
  console.log('0:12-0:16  Short data chirps (quaternary pattern)');
  console.log('0:16-0:18  Silence (VAD test)');
  console.log('0:18-0:20  Low amplitude chirps');
  console.log('0:20-0:22  Rapid alternating tones');
  console.log('0:22-0:24  Final reference tone 1500 Hz');
  console.log('\n=== What to Listen For ===');
  console.log('- Chirps should sound like "swoops" or "whistles"');
  console.log('- If chirps are clearer than steady tones, chirp modulation will help');
  console.log('- If silence causes audio cutoff, we need comfort tone');
  console.log('- Record both ends if possible for comparison');
}

main();
