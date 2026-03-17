#!/usr/bin/env node
/**
 * Pilot Sync Detection Test
 *
 * Tests whether a known MFSK pilot sequence embedded in music
 * can be reliably detected via soft-decision FFT + correlation,
 * replacing the chirp preamble.
 *
 * Usage: node tests/pilot-sync-test.mjs [--quick]
 */

import { execSync } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
const CLI = join(PROJECT_ROOT, 'dist-cli/nedagram-cli/index.cjs');
const MP3_DIR = join(PROJECT_ROOT, 'tests/sample_mp3s');
const TMP = '/tmp/pilot-test';
const isQuick = process.argv.includes('--quick');

// ---- Audio Constants (phone mode) ----
const SAMPLE_RATE = 48000;
const NUM_TONES = 4;
const BASE_FREQ = 800;
const TONE_SPACING = 500;
const SYMBOL_DURATION_MS = 50;
const GUARD_INTERVAL_MS = 12;
const SYMBOL_SAMPLES = Math.round(SAMPLE_RATE * SYMBOL_DURATION_MS / 1000); // 2400
const GUARD_SAMPLES = Math.round(SAMPLE_RATE * GUARD_INTERVAL_MS / 1000);   // 576
const TOTAL_SYMBOL_SAMPLES = SYMBOL_SAMPLES + GUARD_SAMPLES;                // 2976

const TONE_FREQS = Array.from({ length: NUM_TONES }, (_, i) => BASE_FREQ + i * TONE_SPACING);
// [800, 1300, 1800, 2300]

// ---- Pilot Sequence ----
// 24 symbols with good auto-correlation properties
// Contains all 4 tones equally (6 each), palindrome structure
const PILOT_SEQUENCE = [
  0, 1, 2, 3,  3, 2, 1, 0,   // ascending + descending
  0, 2, 1, 3,  3, 1, 2, 0,   // interleaved pattern
  0, 1, 2, 3,  3, 2, 1, 0,   // repeat first for robustness
];

// V3 sync pattern (8 symbols) — appended after pilot for header alignment
const SYNC_PATTERN = [0, 3, 0, 3, 0, 3, 0, 3];

// Full pilot+sync = 32 symbols
const FULL_PILOT = [...PILOT_SEQUENCE, ...SYNC_PATTERN];

// ---- DSP Functions ----

function generateTone(freq, durationSamples, amplitude = 0.85) {
  const samples = new Float32Array(durationSamples);
  for (let i = 0; i < durationSamples; i++) {
    samples[i] = amplitude * Math.sin(2 * Math.PI * freq * i / SAMPLE_RATE);
  }
  return samples;
}

function applyHannFade(samples, fadeSamples) {
  const len = samples.length;
  for (let i = 0; i < fadeSamples && i < len; i++) {
    const w = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));
    samples[i] *= w;
    samples[len - 1 - i] *= w;
  }
  return samples;
}

function generateSymbol(toneIndex, amplitude = 0.85) {
  const freq = TONE_FREQS[toneIndex];
  const tone = generateTone(freq, SYMBOL_SAMPLES, amplitude);
  applyHannFade(tone, GUARD_SAMPLES);

  // Add guard interval (silence)
  const result = new Float32Array(TOTAL_SYMBOL_SAMPLES);
  result.set(tone, 0);
  return result;
}

function generatePilotAudio(sequence, amplitude = 0.85) {
  const totalSamples = sequence.length * TOTAL_SYMBOL_SAMPLES;
  const audio = new Float32Array(totalSamples);
  for (let i = 0; i < sequence.length; i++) {
    const symbol = generateSymbol(sequence[i], amplitude);
    audio.set(symbol, i * TOTAL_SYMBOL_SAMPLES);
  }
  return audio;
}

// Simple FFT (radix-2 Cooley-Tukey)
function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= n; len *= 2) {
    const halfLen = len / 2;
    const angle = -2 * Math.PI / len;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let j = 0; j < halfLen; j++) {
        const tRe = curRe * re[i + j + halfLen] - curIm * im[i + j + halfLen];
        const tIm = curRe * im[i + j + halfLen] + curIm * re[i + j + halfLen];
        re[i + j + halfLen] = re[i + j] - tRe;
        im[i + j + halfLen] = im[i + j] - tIm;
        re[i + j] += tRe;
        im[i + j] += tIm;
        const newCurRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = newCurRe;
      }
    }
  }
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p *= 2;
  return p;
}

// Detect which tone is dominant in a sample window
function detectTone(samples) {
  const fftSize = nextPow2(samples.length);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  re.set(samples);

  fft(re, im);

  // Measure energy at each tone frequency
  const freqResolution = SAMPLE_RATE / fftSize;
  const magnitudes = new Float64Array(NUM_TONES);
  const bandWidth = TONE_SPACING / 2;

  for (let t = 0; t < NUM_TONES; t++) {
    const centerFreq = TONE_FREQS[t];
    const lowBin = Math.max(1, Math.floor((centerFreq - bandWidth) / freqResolution));
    const highBin = Math.min(fftSize / 2 - 1, Math.ceil((centerFreq + bandWidth) / freqResolution));

    let peakMag = 0;
    let sumMag = 0;
    for (let bin = lowBin; bin <= highBin; bin++) {
      const mag = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
      peakMag = Math.max(peakMag, mag);
      sumMag += mag;
    }
    magnitudes[t] = sumMag * 0.3 + peakMag * 0.7; // Same weighting as Nedagram
  }

  // Find best tone
  let bestTone = 0;
  let bestMag = magnitudes[0];
  let secondBest = 0;
  for (let t = 1; t < NUM_TONES; t++) {
    if (magnitudes[t] > bestMag) {
      secondBest = bestMag;
      bestMag = magnitudes[t];
      bestTone = t;
    } else if (magnitudes[t] > secondBest) {
      secondBest = magnitudes[t];
    }
  }

  const confidence = bestMag > 0 ? (bestMag - secondBest) / bestMag : 0;
  return { tone: bestTone, confidence, magnitudes: Array.from(magnitudes) };
}

// Extract symbol stream from audio using sliding window
function extractSymbols(audio, phase = 0) {
  const symbols = [];
  const offset = phase * Math.floor(TOTAL_SYMBOL_SAMPLES / 4);
  let pos = offset;

  while (pos + SYMBOL_SAMPLES <= audio.length) {
    // Skip guard at start and end for cleaner detection
    const analysisStart = pos + Math.floor(GUARD_SAMPLES / 2);
    const analysisLength = SYMBOL_SAMPLES - GUARD_SAMPLES;
    if (analysisStart + analysisLength > audio.length) break;

    const window = audio.slice(analysisStart, analysisStart + analysisLength);
    const result = detectTone(window);
    symbols.push(result);

    pos += TOTAL_SYMBOL_SAMPLES;
  }
  return symbols;
}

// Correlate symbol stream against pilot pattern
function correlateWithPilot(symbols, pilot) {
  if (symbols.length < pilot.length) return { found: false, position: -1, correlation: 0 };

  let bestCorr = 0;
  let bestPos = -1;

  for (let offset = 0; offset <= symbols.length - pilot.length; offset++) {
    let matches = 0;
    let totalConf = 0;
    for (let j = 0; j < pilot.length; j++) {
      if (symbols[offset + j].tone === pilot[j]) {
        matches++;
        totalConf += symbols[offset + j].confidence;
      }
    }
    const matchRatio = matches / pilot.length;
    // Weight by both match count and confidence
    const score = matchRatio * 0.7 + (totalConf / pilot.length) * 0.3;

    if (score > bestCorr) {
      bestCorr = score;
      bestPos = offset;
    }
  }

  // Calculate match ratio at best position
  let matchCount = 0;
  for (let j = 0; j < pilot.length; j++) {
    if (symbols[bestPos + j].tone === pilot[j]) matchCount++;
  }

  return {
    found: bestCorr > 0.4,
    position: bestPos,
    correlation: bestCorr,
    matchRatio: matchCount / pilot.length,
    matchCount,
    totalSymbols: pilot.length,
  };
}

// ---- WAV I/O ----

function readWavSamples(path) {
  const buf = readFileSync(path);
  let offset = 12;
  while (offset < buf.length - 8) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'data') {
      const numSamples = Math.floor(size / 2);
      const samples = new Float32Array(numSamples);
      for (let i = 0; i < numSamples; i++) {
        samples[i] = buf.readInt16LE(offset + 8 + i * 2) / 32768;
      }
      return samples;
    }
    offset += 8 + size;
    if (size % 2 !== 0) offset++;
  }
  throw new Error(`No data chunk in ${path}`);
}

function writeWavFile(path, samples) {
  const numSamples = samples.length;
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(SAMPLE_RATE * 2, 28);
  buf.writeUInt16LE(2, 30);
  buf.writeUInt16LE(16, 32);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

function run(cmd) {
  execSync(cmd + ' 2>/dev/null', { stdio: ['pipe', 'pipe', 'pipe'] });
}

function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

// ---- Main Test ----

async function main() {
  mkdirSync(TMP, { recursive: true });

  console.log('\n=== PILOT SYNC DETECTION TEST ===\n');

  // 1. Test auto-correlation of pilot in silence (baseline)
  console.log('--- Baseline: Pilot in silence ---');
  const pilotAudio = generatePilotAudio(FULL_PILOT);
  const silenceSymbols = extractSymbols(pilotAudio);
  const silenceResult = correlateWithPilot(silenceSymbols, FULL_PILOT);
  console.log(`  Symbols extracted: ${silenceSymbols.length}`);
  console.log(`  Match: ${silenceResult.matchCount}/${silenceResult.totalSymbols} (${(silenceResult.matchRatio * 100).toFixed(0)}%)`);
  console.log(`  Score: ${silenceResult.correlation.toFixed(3)}`);
  console.log(`  Position: ${silenceResult.position} (expected: 0)`);
  console.log(`  ${silenceResult.found ? '\x1b[32mDETECTED\x1b[0m' : '\x1b[31mMISSED\x1b[0m'}`);

  // 2. Test with pilot preceded by random symbols (timing test)
  console.log('\n--- Timing: Pilot after 20 random symbols ---');
  const randomPrefix = Array.from({ length: 20 }, () => Math.floor(Math.random() * 4));
  const prefixedSequence = [...randomPrefix, ...FULL_PILOT];
  const prefixedAudio = generatePilotAudio(prefixedSequence);
  const prefixedSymbols = extractSymbols(prefixedAudio);
  const prefixResult = correlateWithPilot(prefixedSymbols, FULL_PILOT);
  console.log(`  Match: ${prefixResult.matchCount}/${prefixResult.totalSymbols} (${(prefixResult.matchRatio * 100).toFixed(0)}%)`);
  console.log(`  Position: ${prefixResult.position} (expected: 20)`);
  console.log(`  ${prefixResult.found && prefixResult.position === 20 ? '\x1b[32mDETECTED at correct position\x1b[0m' : '\x1b[31mFAILED\x1b[0m'}`);

  // 3. Encode test message (to append after pilot for full decode test later)
  const tonesPath = join(TMP, 'tones.wav');
  execSync(`node "${CLI}" encode "Hello from pilot sync test" -o "${tonesPath}" -m phone -q`);
  const tonesAudio = readWavSamples(tonesPath);
  console.log(`\n  Data tones: ${(tonesAudio.length / SAMPLE_RATE).toFixed(1)}s`);

  // 4. Generate pilot + data combined signal
  const pilotDataAudio = new Float32Array(pilotAudio.length + tonesAudio.length);
  pilotDataAudio.set(pilotAudio, 0);
  pilotDataAudio.set(tonesAudio, pilotAudio.length);
  const pilotDataRms = rms(pilotDataAudio);
  console.log(`  Pilot+data combined: ${(pilotDataAudio.length / SAMPLE_RATE).toFixed(1)}s, RMS: ${pilotDataRms.toFixed(4)}`);

  // 5. Test against each music file at various TMR levels
  const mp3Files = readdirSync(MP3_DIR).filter(f => f.endsWith('.mp3'));
  const testMp3s = isQuick ? mp3Files.slice(0, 2) : mp3Files;
  const tmrLevels = isQuick ? [-3, -6, -10] : [-3, -6, -8, -10, -12, -15];
  const codecs = [
    { name: 'none', apply: null },
    ...(isQuick ? [] : [
      { name: 'amr-12.2k', apply: (inp, out) => {
        run(`ffmpeg -y -i "${inp}" -ar 8000 -ac 1 -c:a libopencore_amrnb -b:a 12200 "${out}.amr"`);
        run(`ffmpeg -y -i "${out}.amr" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${out}"`);
      }},
    ]),
  ];

  const results = [];

  for (const mp3File of testMp3s) {
    const mp3Path = join(MP3_DIR, mp3File);
    const tag = basename(mp3File, '.mp3').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);

    console.log(`\n${'='.repeat(70)}`);
    console.log(`Music: ${mp3File}`);
    console.log(`${'='.repeat(70)}`);

    // Convert MP3 to WAV
    const trimDuration = pilotDataAudio.length / SAMPLE_RATE + 2;
    const musicWav = join(TMP, `music-${tag}.wav`);
    run(`ffmpeg -y -i "${mp3Path}" -t ${trimDuration} -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${musicWav}"`);
    const musicAudio = readWavSamples(musicWav);
    const musicRms = rms(musicAudio);
    console.log(`  Music: ${(musicAudio.length / SAMPLE_RATE).toFixed(1)}s, RMS: ${musicRms.toFixed(4)} (${(20 * Math.log10(musicRms)).toFixed(1)} dB)`);

    for (const tmrDb of tmrLevels) {
      // Scale pilot+data to target TMR relative to music
      const targetRms = musicRms * dbToLinear(tmrDb);
      const scaleFactor = targetRms / pilotDataRms;

      // Mix: music starts 0.3s before pilot (simulates random start)
      const musicOffset = Math.floor(0.3 * SAMPLE_RATE);
      const totalLen = Math.max(musicAudio.length, pilotDataAudio.length + musicOffset);
      const mixed = new Float32Array(totalLen);

      for (let i = 0; i < totalLen; i++) {
        if (i < musicAudio.length) mixed[i] = musicAudio[i];
        const pilotIdx = i - musicOffset;
        if (pilotIdx >= 0 && pilotIdx < pilotDataAudio.length) {
          mixed[i] += pilotDataAudio[pilotIdx] * scaleFactor;
        }
        mixed[i] = Math.max(-1, Math.min(1, mixed[i]));
      }

      for (const codec of codecs) {
        let testAudio;

        if (!codec.apply) {
          // No codec — detect directly from in-memory mixed audio
          testAudio = mixed;
        } else {
          // Write WAV via ffmpeg (raw PCM pipe), apply codec, read back
          const rawPath = join(TMP, `praw-${tag}_${tmrDb}dB.pcm`);
          const pcmBuf = Buffer.alloc(mixed.length * 2);
          for (let i = 0; i < mixed.length; i++) {
            pcmBuf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, mixed[i])) * 32767), i * 2);
          }
          writeFileSync(rawPath, pcmBuf);

          const mixedWav = join(TMP, `pmixed-${tag}_${tmrDb}dB.wav`);
          run(`ffmpeg -y -f s16le -ar ${SAMPLE_RATE} -ac 1 -i "${rawPath}" -c:a pcm_s16le "${mixedWav}"`);

          const codecPath = join(TMP, `pcodec-${tag}_${tmrDb}dB_${codec.name}.wav`);
          try {
            codec.apply(mixedWav, codecPath);
            testAudio = readWavSamples(codecPath);
          } catch {
            console.log(`  TMR ${String(tmrDb).padStart(3)} dB + ${codec.name.padEnd(12)}: \x1b[31mCODEC ERROR\x1b[0m`);
            results.push({ music: tag, tmr: tmrDb, codec: codec.name, result: 'CODEC_ERROR' });
            continue;
          }
        }

        // Try all 4 phases
        let bestResult = null;
        let bestPhase = -1;
        for (let phase = 0; phase < 4; phase++) {
          const symbols = extractSymbols(testAudio, phase);
          const result = correlateWithPilot(symbols, FULL_PILOT);
          if (!bestResult || result.correlation > bestResult.correlation) {
            bestResult = result;
            bestPhase = phase;
          }
        }

        // Calculate timing accuracy
        const expectedPosition = Math.round(musicOffset / TOTAL_SYMBOL_SAMPLES);
        const positionError = bestResult.position - expectedPosition;

        const detected = bestResult.found;
        const timingOk = Math.abs(positionError) <= 2;
        const passed = detected && timingOk;

        const color = passed ? '\x1b[32m' : detected ? '\x1b[33m' : '\x1b[31m';
        const status = passed ? 'PASS' : detected ? 'TIMING' : 'MISS';
        console.log(
          `  TMR ${String(tmrDb).padStart(3)} dB + ${codec.name.padEnd(12)}: ${color}${status}\x1b[0m` +
          `  match=${bestResult.matchCount}/${bestResult.totalSymbols}` +
          `  score=${bestResult.correlation.toFixed(3)}` +
          `  phase=${bestPhase}` +
          `  pos=${bestResult.position} (exp:${expectedPosition}, err:${positionError > 0 ? '+' : ''}${positionError})`
        );

        results.push({
          music: tag,
          tmr: tmrDb,
          codec: codec.name,
          result: status,
          matchRatio: bestResult.matchRatio,
          score: bestResult.correlation,
          phase: bestPhase,
          position: bestResult.position,
          expectedPosition,
          positionError,
        });
      }
    }
  }

  // Summary
  console.log(`\n${'='.repeat(70)}`);
  console.log('PILOT DETECTION SUMMARY');
  console.log(`${'='.repeat(70)}`);
  console.log(`\n${'Music'.padEnd(32)} ${'TMR'.padEnd(7)} ${'Codec'.padEnd(14)} ${'Match'.padEnd(8)} ${'Score'.padEnd(8)} Result`);
  console.log('-'.repeat(80));
  for (const r of results) {
    const color = r.result === 'PASS' ? '\x1b[32m' : r.result === 'MISS' ? '\x1b[31m' : '\x1b[33m';
    const matchPct = r.matchRatio !== undefined ? `${(r.matchRatio * 100).toFixed(0)}%` : '';
    const score = r.score !== undefined ? r.score.toFixed(3) : '';
    console.log(`${r.music.padEnd(32)} ${String(r.tmr).padStart(4)}dB  ${r.codec.padEnd(14)} ${matchPct.padEnd(8)} ${score.padEnd(8)} ${color}${r.result}\x1b[0m`);
  }

  const passCount = results.filter(r => r.result === 'PASS').length;
  const total = results.length;
  console.log(`\n${passCount}/${total} pilot detections successful`);

  // Compare with chirp-based results
  console.log(`\nFor comparison: chirp-based decoder passed 18/80 tests (same songs, same conditions)`);

  writeFileSync(join(TMP, 'pilot-results.json'), JSON.stringify(results, null, 2));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
