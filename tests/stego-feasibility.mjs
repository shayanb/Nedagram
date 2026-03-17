#!/usr/bin/env node
/**
 * Music Steganography Feasibility Test (Phase 1)
 *
 * Tests whether MFSK tones mixed into music at various amplitudes
 * can be decoded by the existing Nedagram decoder, with and without
 * phone codec compression.
 *
 * Usage: node tests/stego-feasibility.mjs [--quick]
 *
 * Requires: ffmpeg with libopencore_amrnb and libopus
 */

import { execSync } from 'child_process';
import { writeFileSync, mkdirSync, readdirSync } from 'fs';
import { join, basename } from 'path';

const PROJECT_ROOT = new URL('..', import.meta.url).pathname;
const CLI = join(PROJECT_ROOT, 'dist-cli/nedagram-cli/index.cjs');
const MP3_DIR = join(PROJECT_ROOT, 'tests/sample_mp3s');
const TMP = '/tmp/stego-test';
const SAMPLE_RATE = 48000;

const TEST_MESSAGE = 'Hello from music steganography test';
const TMR_LEVELS = [-3, -6, -10, -15, -20]; // dB
const CODECS = [
  { name: 'none', apply: null },
  { name: 'amr-nb-12.2k', apply: (inp, out) => {
    run(`ffmpeg -y -i "${inp}" -ar 8000 -ac 1 -c:a libopencore_amrnb -b:a 12200 "${out}.amr"`);
    run(`ffmpeg -y -i "${out}.amr" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${out}"`);
  }},
  { name: 'amr-double', apply: (inp, out) => {
    run(`ffmpeg -y -i "${inp}" -ar 8000 -ac 1 -c:a libopencore_amrnb -b:a 12200 "${out}.p1.amr"`);
    run(`ffmpeg -y -i "${out}.p1.amr" -ar 8000 -ac 1 -c:a libopencore_amrnb -b:a 12200 "${out}.p2.amr"`);
    run(`ffmpeg -y -i "${out}.p2.amr" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${out}"`);
  }},
  { name: 'opus-32k', apply: (inp, out) => {
    run(`ffmpeg -y -i "${inp}" -c:a libopus -b:a 32k -ar ${SAMPLE_RATE} -ac 1 "${out}.opus"`);
    run(`ffmpeg -y -i "${out}.opus" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${out}"`);
  }},
];

const isQuick = process.argv.includes('--quick');

function run(cmd) {
  execSync(cmd + ' 2>/dev/null', { stdio: ['pipe', 'pipe', 'pipe'] });
}

function sanitize(s) {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
}

async function main() {
  mkdirSync(TMP, { recursive: true });

  // 1. Encode test message to WAV
  const tonesPath = join(TMP, 'tones.wav');
  console.log(`\nEncoding test message: "${TEST_MESSAGE}"`);
  execSync(`node "${CLI}" encode "${TEST_MESSAGE}" -o "${tonesPath}" -m phone -q`);

  // Get tones duration
  const tonesInfo = execSync(`ffprobe -v quiet -show_entries format=duration -of csv=p=0 "${tonesPath}"`).toString().trim();
  const tonesDuration = parseFloat(tonesInfo);
  console.log(`  Tones duration: ${tonesDuration.toFixed(1)}s`);

  // 2. Find MP3 files
  const mp3Files = readdirSync(MP3_DIR).filter(f => f.endsWith('.mp3'));
  console.log(`\nFound ${mp3Files.length} music files:`);
  mp3Files.forEach(f => console.log(`  - ${f}`));

  const testMp3s = isQuick ? mp3Files.slice(0, 2) : mp3Files;
  const testTmrs = isQuick ? [-3, -6, -10] : TMR_LEVELS;
  const testCodecs = isQuick ? CODECS.slice(0, 2) : CODECS;

  const results = [];

  for (const mp3File of testMp3s) {
    const mp3Path = join(MP3_DIR, mp3File);
    const tag = sanitize(basename(mp3File, '.mp3'));

    console.log(`\n${'='.repeat(70)}`);
    console.log(`Music: ${mp3File}`);
    console.log(`${'='.repeat(70)}`);

    // Convert MP3 to mono WAV, trimmed to tones duration + 1s padding
    const trimDuration = tonesDuration + 1.5;
    const musicWav = join(TMP, `music-${tag}.wav`);
    run(`ffmpeg -y -i "${mp3Path}" -t ${trimDuration} -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${musicWav}"`);

    // Get music RMS in dB using ffmpeg
    const loudnessOut = execSync(`ffmpeg -i "${musicWav}" -af "volumedetect" -f null /dev/null 2>&1`).toString();
    const rmsMatch = loudnessOut.match(/mean_volume:\s*([-\d.]+)/);
    const musicRmsDb = rmsMatch ? parseFloat(rmsMatch[1]) : -20;
    console.log(`  Music RMS: ${musicRmsDb.toFixed(1)} dB`);

    for (const tmrDb of testTmrs) {
      // TMR is tone volume relative to music
      // tone_volume_dB = music_rms_dB + tmr_dB
      // scale = 10^(tmr_dB / 20) relative to 1.0 (since tones are already at ~0.5 RMS)
      //
      // Use ffmpeg amix to combine. We need to scale the tones so that
      // toneRMS = musicRMS * 10^(tmr/20)
      //
      // Since tones are at RMS ~0.5 (-6dB) and music varies,
      // the scale factor for tones = musicRMS_linear * 10^(tmr/20) / tonesRMS_linear
      // But simpler: use ffmpeg volume filter on the tones.

      // tones are at ~-6dBFS, music varies. We want toneRMS to be tmrDb below musicRMS.
      // So tone output level = musicRmsDb + tmrDb
      // Current tone level ≈ -6 dBFS
      // Volume adjustment = (musicRmsDb + tmrDb) - (-6) = musicRmsDb + tmrDb + 6
      const toneAdjustDb = musicRmsDb + tmrDb + 6;

      for (const codec of testCodecs) {
        const mixedPath = join(TMP, `mixed-${tag}_${tmrDb}dB.wav`);
        const codecPath = join(TMP, `codec-${tag}_${tmrDb}dB_${codec.name}.wav`);

        // Mix music + scaled tones using ffmpeg
        // adelay=500 adds 0.5s of music before tones start
        try {
          run(`ffmpeg -y -i "${musicWav}" -i "${tonesPath}" -filter_complex "[1:a]volume=${toneAdjustDb}dB,adelay=500|500[tones];[0:a][tones]amix=inputs=2:duration=first:dropout_transition=0[out]" -map "[out]" -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le "${mixedPath}"`);
        } catch (e) {
          console.log(`  TMR ${String(tmrDb).padStart(3)} dB + ${codec.name.padEnd(20)}: \x1b[31mMIX ERROR\x1b[0m`);
          results.push({ music: tag, tmr: tmrDb, codec: codec.name, result: 'MIX_ERROR' });
          continue;
        }

        // Apply codec if needed
        let decodePath = mixedPath;
        if (codec.apply) {
          try {
            codec.apply(mixedPath, codecPath);
            decodePath = codecPath;
          } catch (e) {
            console.log(`  TMR ${String(tmrDb).padStart(3)} dB + ${codec.name.padEnd(20)}: \x1b[31mCODEC ERROR\x1b[0m`);
            results.push({ music: tag, tmr: tmrDb, codec: codec.name, result: 'CODEC_ERROR' });
            continue;
          }
        }

        // Try to decode
        try {
          const output = execSync(
            `node "${CLI}" decode "${decodePath}" -q 2>&1`,
            { timeout: 45000 }
          ).toString().trim();

          const success = output.includes(TEST_MESSAGE);
          const symbol = success ? 'PASS' : 'WRONG';
          const color = success ? '\x1b[32m' : '\x1b[33m';
          console.log(`  TMR ${String(tmrDb).padStart(3)} dB + ${codec.name.padEnd(20)}: ${color}${symbol}\x1b[0m${success ? '' : ` ("${output.slice(0, 60)}")`}`);
          results.push({ music: tag, tmr: tmrDb, codec: codec.name, result: symbol, toneAdjustDb: Math.round(toneAdjustDb) });
        } catch (e) {
          const stderr = (e.stderr?.toString() || '') + (e.stdout?.toString() || '');
          const isV2 = stderr.includes('v2');
          const hint = isV2 ? ' (v2 detected)' : '';
          console.log(`  TMR ${String(tmrDb).padStart(3)} dB + ${codec.name.padEnd(20)}: \x1b[31mFAIL\x1b[0m${hint}`);
          results.push({ music: tag, tmr: tmrDb, codec: codec.name, result: 'FAIL', toneAdjustDb: Math.round(toneAdjustDb) });
        }
      }
    }
  }

  // Summary
  console.log(`\n${'='.repeat(70)}`);
  console.log('SUMMARY');
  console.log(`${'='.repeat(70)}`);
  console.log(`\n${'Music'.padEnd(32)} ${'TMR'.padEnd(7)} ${'Codec'.padEnd(22)} ${'Adj'.padEnd(7)} Result`);
  console.log('-'.repeat(78));
  for (const r of results) {
    const color = r.result === 'PASS' ? '\x1b[32m' : r.result === 'FAIL' || r.result === 'TIMEOUT' ? '\x1b[31m' : '\x1b[33m';
    const adj = r.toneAdjustDb !== undefined ? `${r.toneAdjustDb}dB` : '';
    console.log(`${r.music.padEnd(32)} ${String(r.tmr).padStart(4)}dB  ${r.codec.padEnd(22)} ${adj.padEnd(7)} ${color}${r.result}\x1b[0m`);
  }

  const passCount = results.filter(r => r.result === 'PASS').length;
  const total = results.length;
  console.log(`\n${passCount}/${total} tests passed`);

  writeFileSync(join(TMP, 'results.json'), JSON.stringify(results, null, 2));
  console.log(`Results saved to: ${join(TMP, 'results.json')}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
