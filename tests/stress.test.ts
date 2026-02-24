/**
 * Stress Tests: FEC & Decoder Robustness
 *
 * Characterizes the error correction limits of the v3 protocol at every layer.
 * These tests are expensive — run with: npm run test:stress
 *
 * Gated by STRESS=1 environment variable (skipped in normal test runs).
 */

import { describe, it, expect, afterAll } from 'vitest';
import { encodeDataV3FEC, encodeHeaderV3FEC, V3_FEC_CONFIG } from '../src/encode/v3-fec';
import {
  decodeDataV3FEC,
  decodeDataV3FECSoft,
  decodeHeaderV3FEC,
  decodeHeaderV3FECSoft,
  decodeHeaderV3FECWithRedundancy,
  decodeHeaderV3FECSoftWithRedundancy,
} from '../src/decode/v3-fec';
import { unpackBits, hardToSoft } from '../src/decode/viterbi';
import { interleave, deinterleave, calculateInterleaverDepth } from '../src/encode/interleave';
import { createHeaderFrame, createDataFrame } from '../src/encode/frame';
import { parseHeaderFrame, parseDataFrame } from '../src/decode/deframe';

// ─── Test Helpers ────────────────────────────────────────────────────────────

/** Corrupt N random byte positions (XOR with random non-zero value) */
function corruptBytes(data: Uint8Array, numErrors: number): Uint8Array {
  const corrupted = new Uint8Array(data);
  const positions = new Set<number>();
  while (positions.size < Math.min(numErrors, data.length)) {
    positions.add(Math.floor(Math.random() * data.length));
  }
  for (const pos of positions) {
    corrupted[pos] ^= (Math.floor(Math.random() * 255) + 1); // non-zero XOR
  }
  return corrupted;
}

/** Corrupt a burst of consecutive bytes (set to 0xFF) */
function corruptBurst(data: Uint8Array, start: number, length: number): Uint8Array {
  const corrupted = new Uint8Array(data);
  for (let i = start; i < Math.min(start + length, data.length); i++) {
    corrupted[i] ^= 0xFF;
  }
  return corrupted;
}

/** Flip random bits at the given Bit Error Rate */
function corruptBits(data: Uint8Array, ber: number): Uint8Array {
  const corrupted = new Uint8Array(data);
  const totalBits = data.length * 8;
  const numErrors = Math.floor(totalBits * ber);
  const flipped = new Set<number>();
  while (flipped.size < Math.min(numErrors, totalBits)) {
    flipped.add(Math.floor(Math.random() * totalBits));
  }
  for (const bitPos of flipped) {
    const byteIdx = Math.floor(bitPos / 8);
    const bitIdx = bitPos % 8;
    corrupted[byteIdx] ^= (1 << bitIdx);
  }
  return corrupted;
}

/** Add Gaussian noise to soft bits, clamped to [0,1] */
function addGaussianNoise(softBits: number[], sigma: number): number[] {
  return softBits.map(b => {
    // Box-Muller transform
    const u1 = Math.random() || 1e-10;
    const u2 = Math.random();
    const noise = sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, Math.min(1, b + noise));
  });
}

/** Set a fraction of soft bits to 0.5 (erasure/maximum uncertainty) */
function addErasures(softBits: number[], fraction: number): number[] {
  return softBits.map(b => Math.random() < fraction ? 0.5 : b);
}

/** Build a test data frame: [D, frameIndex, payloadLen, ...payload] */
function makeTestDataFrame(payloadSize: number, frameIndex: number = 1): Uint8Array {
  const frame = new Uint8Array(3 + payloadSize);
  frame[0] = 0x44; // 'D'
  frame[1] = frameIndex;
  frame[2] = payloadSize;
  for (let i = 3; i < frame.length; i++) {
    frame[i] = (i * 7 + frameIndex) % 256;
  }
  return frame;
}

/** Build a test header frame using the real createHeaderFrame function */
function makeTestHeaderFrame(): Uint8Array {
  const { frame } = createHeaderFrame(3, 256, 300, true);
  return frame;
}

/** Run N trials of a test function, return pass count */
function runTrials(n: number, testFn: () => boolean): { passed: number; total: number } {
  let passed = 0;
  for (let i = 0; i < n; i++) {
    if (testFn()) passed++;
  }
  return { passed, total: n };
}

// ─── Results Collector ───────────────────────────────────────────────────────

interface StressResult {
  category: string;
  test: string;
  passed: number;
  total: number;
  threshold?: string;
}

const results: StressResult[] = [];

function record(category: string, test: string, passed: number, total: number, threshold?: string) {
  results.push({ category, test, passed, total, threshold });
}

// ─── Stress Tests ────────────────────────────────────────────────────────────

const STRESS_ENABLED = process.env.STRESS === '1';
const TRIALS = 10;
const PAYLOAD_SIZE = 64;

describe.runIf(STRESS_ENABLED)('Stress Tests', () => {

  afterAll(() => {
    // Print summary table
    console.log('\n');
    console.log('┌──────────────────────────────────────────────────────┬────────────┬───────────┐');
    console.log('│ Test                                                 │ Result     │ Threshold │');
    console.log('├──────────────────────────────────────────────────────┼────────────┼───────────┤');
    for (const r of results) {
      const name = `${r.category}: ${r.test}`.padEnd(52);
      const result = `${r.passed}/${r.total}`.padEnd(10);
      const thresh = (r.threshold ?? '').padEnd(9);
      console.log(`│ ${name} │ ${result} │ ${thresh} │`);
    }
    console.log('└──────────────────────────────────────────────────────┴────────────┴───────────┘');
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Layer 1: FEC Hard-Decision Limits
  // ═══════════════════════════════════════════════════════════════════════════

  describe('FEC hard-decision limits', () => {
    const testFrame = makeTestDataFrame(PAYLOAD_SIZE);
    const encoded = encodeDataV3FEC(testFrame);

    describe('random byte errors', () => {
      for (const numErrors of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]) {
        it(`should handle ${numErrors} random byte errors`, () => {
          const { passed, total } = runTrials(TRIALS, () => {
            const corrupted = corruptBytes(encoded, numErrors);
            const result = decodeDataV3FEC(corrupted, PAYLOAD_SIZE);
            return result.success && arraysEqual(result.data, testFrame);
          });

          record('Hard FEC', `${numErrors} byte errors`, passed, total);

          // Only assert for very low error counts (1-2 bytes at encoded level)
          if (numErrors <= 2) {
            expect(passed).toBeGreaterThanOrEqual(Math.floor(total * 0.5));
          }
        });
      }
    });

    describe('burst errors', () => {
      for (const burstLen of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15]) {
        it(`should handle burst of ${burstLen} consecutive bytes`, () => {
          const { passed, total } = runTrials(TRIALS, () => {
            const start = Math.floor(Math.random() * Math.max(1, encoded.length - burstLen));
            const corrupted = corruptBurst(encoded, start, burstLen);
            const result = decodeDataV3FEC(corrupted, PAYLOAD_SIZE);
            return result.success && arraysEqual(result.data, testFrame);
          });

          record('Hard FEC', `burst ${burstLen}B`, passed, total);
        });
      }
    });

    describe('bit error rate sweep', () => {
      for (const ber of [0.01, 0.02, 0.03, 0.04, 0.05, 0.07, 0.10, 0.12, 0.15]) {
        it(`should handle ${(ber * 100).toFixed(0)}% BER`, () => {
          const { passed, total } = runTrials(TRIALS, () => {
            const corrupted = corruptBits(encoded, ber);
            const result = decodeDataV3FEC(corrupted, PAYLOAD_SIZE);
            return result.success && arraysEqual(result.data, testFrame);
          });

          record('Hard FEC', `${(ber * 100).toFixed(0)}% BER`, passed, total,
            passed >= total / 2 ? 'pass' : 'FAIL');

          // Only assert at very low BER (1% should be correctable)
          if (ber <= 0.01) {
            expect(passed).toBeGreaterThanOrEqual(Math.floor(total * 0.5));
          }
        });
      }
    });

    it('should handle errors at worst-case positions (frame start)', () => {
      const { passed, total } = runTrials(TRIALS, () => {
        const corrupted = new Uint8Array(encoded);
        // Corrupt first 4 bytes (magic + frame index + length)
        for (let i = 0; i < 4; i++) corrupted[i] ^= 0xFF;
        const result = decodeDataV3FEC(corrupted, PAYLOAD_SIZE);
        return result.success && arraysEqual(result.data, testFrame);
      });

      record('Hard FEC', 'worst-case: start', passed, total);
      expect(passed).toBeGreaterThanOrEqual(1);
    });

    it('should handle errors at worst-case positions (frame end / parity)', () => {
      const { passed, total } = runTrials(TRIALS, () => {
        const corrupted = new Uint8Array(encoded);
        // Corrupt last 4 bytes (likely parity region after Viterbi)
        for (let i = corrupted.length - 4; i < corrupted.length; i++) {
          corrupted[i] ^= 0xFF;
        }
        const result = decodeDataV3FEC(corrupted, PAYLOAD_SIZE);
        return result.success && arraysEqual(result.data, testFrame);
      });

      record('Hard FEC', 'worst-case: end', passed, total);
      expect(passed).toBeGreaterThanOrEqual(1);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Layer 2: FEC Soft-Decision Limits
  // ═══════════════════════════════════════════════════════════════════════════

  describe('FEC soft-decision limits', () => {
    const testFrame = makeTestDataFrame(PAYLOAD_SIZE);
    const encoded = encodeDataV3FEC(testFrame);
    const cleanSoftBits = hardToSoft(unpackBits(encoded));

    describe('gaussian noise sweep', () => {
      for (const sigma of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45]) {
        it(`should handle Gaussian noise sigma=${sigma.toFixed(2)}`, () => {
          const { passed, total } = runTrials(TRIALS, () => {
            const noisySoft = addGaussianNoise(cleanSoftBits, sigma);
            const result = decodeDataV3FECSoft(noisySoft, PAYLOAD_SIZE);
            return result.success && arraysEqual(result.data, testFrame);
          });

          record('Soft FEC', `σ=${sigma.toFixed(2)}`, passed, total,
            passed >= total / 2 ? 'pass' : 'FAIL');

          // Low noise should be correctable
          if (sigma <= 0.10) {
            expect(passed).toBeGreaterThanOrEqual(Math.floor(total * 0.5));
          }
        });
      }
    });

    describe('erasure sweep', () => {
      for (const fraction of [0.05, 0.10, 0.15, 0.20, 0.30, 0.40, 0.50]) {
        it(`should handle ${(fraction * 100).toFixed(0)}% erasures`, () => {
          const { passed, total } = runTrials(TRIALS, () => {
            const erased = addErasures(cleanSoftBits, fraction);
            const result = decodeDataV3FECSoft(erased, PAYLOAD_SIZE);
            return result.success && arraysEqual(result.data, testFrame);
          });

          record('Soft FEC', `${(fraction * 100).toFixed(0)}% erasures`, passed, total,
            passed >= total / 2 ? 'pass' : 'FAIL');
        });
      }
    });

    describe('hard vs soft comparison', () => {
      for (const numErrors of [4, 6, 8, 10]) {
        it(`should show soft advantage at ${numErrors} byte errors`, () => {
          const trials = 20;
          let hardPassed = 0;
          let softPassed = 0;

          for (let i = 0; i < trials; i++) {
            const corrupted = corruptBytes(encoded, numErrors);

            // Hard decode
            const hardResult = decodeDataV3FEC(corrupted, PAYLOAD_SIZE);
            if (hardResult.success && arraysEqual(hardResult.data, testFrame)) {
              hardPassed++;
            }

            // Soft decode (convert corrupted bytes to soft bits)
            const softBits = hardToSoft(unpackBits(corrupted));
            const softResult = decodeDataV3FECSoft(softBits, PAYLOAD_SIZE);
            if (softResult.success && arraysEqual(softResult.data, testFrame)) {
              softPassed++;
            }
          }

          record('Hard vs Soft', `${numErrors} errs: hard`, hardPassed, trials);
          record('Hard vs Soft', `${numErrors} errs: soft`, softPassed, trials);

          // Observational — soft with hard inputs (0.0/1.0) may not outperform
          // The real soft advantage is with analog confidence values
        });
      }
    });

    it('should handle mixed: Gaussian noise + burst erasure', () => {
      const { passed, total } = runTrials(TRIALS, () => {
        let noisy = addGaussianNoise(cleanSoftBits, 0.20);
        // Add burst erasure (20 consecutive soft bits → 0.5)
        const burstStart = Math.floor(Math.random() * (noisy.length - 80));
        for (let i = burstStart; i < burstStart + 80; i++) {
          noisy[i] = 0.5;
        }
        const result = decodeDataV3FECSoft(noisy, PAYLOAD_SIZE);
        return result.success && arraysEqual(result.data, testFrame);
      });

      record('Soft FEC', 'σ=0.20 + 10B burst', passed, total);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Layer 3: Interleaver Effectiveness
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Interleaver burst protection', () => {
    const testFrame = makeTestDataFrame(PAYLOAD_SIZE);
    const encoded = encodeDataV3FEC(testFrame);
    const interleaverDepth = calculateInterleaverDepth(encoded.length);
    const interleaved = interleave(encoded, interleaverDepth);

    for (const burstLen of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 18, 20]) {
      it(`burst ${burstLen}B: with vs without interleaving`, () => {
        let withoutPassed = 0;
        let withPassed = 0;

        for (let t = 0; t < TRIALS; t++) {
          const start = Math.floor(Math.random() * Math.max(1, encoded.length - burstLen));

          // WITHOUT interleaving: corrupt encoded directly
          const corruptedDirect = corruptBurst(encoded, start, burstLen);
          const resultDirect = decodeDataV3FEC(corruptedDirect, PAYLOAD_SIZE);
          if (resultDirect.success && arraysEqual(resultDirect.data, testFrame)) {
            withoutPassed++;
          }

          // WITH interleaving: corrupt interleaved, then deinterleave
          const corruptedInterleaved = corruptBurst(interleaved, start, burstLen);
          const deinterleavedCorrupted = deinterleave(corruptedInterleaved, interleaverDepth, encoded.length);
          const resultInterleaved = decodeDataV3FEC(deinterleavedCorrupted, PAYLOAD_SIZE);
          if (resultInterleaved.success && arraysEqual(resultInterleaved.data, testFrame)) {
            withPassed++;
          }
        }

        record('Interleaver', `burst ${burstLen}B: w/o`, withoutPassed, TRIALS);
        record('Interleaver', `burst ${burstLen}B: w/`, withPassed, TRIALS);

        // Interleaving should generally help for longer bursts (observational)
        // No hard assertion — the summary table shows the difference
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Layer 4: Header Redundancy
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Header redundancy stress', () => {
    const headerFrame = makeTestHeaderFrame();
    const encodedHeader = encodeHeaderV3FEC(headerFrame);

    it('should survive when one copy is destroyed', () => {
      const { passed, total } = runTrials(TRIALS, () => {
        const clean = new Uint8Array(encodedHeader);
        // Destroy copy2 (50% byte errors)
        const destroyed = corruptBytes(encodedHeader, Math.floor(encodedHeader.length * 0.5));
        const result = decodeHeaderV3FECWithRedundancy(clean, destroyed);
        return result.success && arraysEqual(result.data, headerFrame);
      });

      record('Header', 'one copy destroyed', passed, total);
      expect(passed).toBe(total);
    });

    describe('both copies with moderate errors', () => {
      for (const numErrors of [2, 3, 4, 5, 6, 7, 8]) {
        it(`should handle ${numErrors} errors in each copy`, () => {
          const { passed, total } = runTrials(TRIALS, () => {
            const copy1 = corruptBytes(encodedHeader, numErrors);
            const copy2 = corruptBytes(encodedHeader, numErrors);
            const result = decodeHeaderV3FECWithRedundancy(copy1, copy2);
            return result.success && arraysEqual(result.data, headerFrame);
          });

          record('Header', `${numErrors} errs each copy`, passed, total);

          if (numErrors <= 5) {
            expect(passed).toBeGreaterThanOrEqual(Math.floor(total * 0.5));
          }
        });
      }
    });

    it('should benefit from soft redundancy combining', () => {
      const cleanSoft = hardToSoft(unpackBits(encodedHeader));
      let combinedPassed = 0;
      let singlePassed = 0;
      const trials = 20;

      for (let i = 0; i < trials; i++) {
        // Two independently noisy copies
        const noisy1 = addGaussianNoise(cleanSoft, 0.30);
        const noisy2 = addGaussianNoise(cleanSoft, 0.30);

        // Soft redundancy (averages two copies)
        const combined = decodeHeaderV3FECSoftWithRedundancy(noisy1, noisy2);
        if (combined.success && arraysEqual(combined.data, headerFrame)) {
          combinedPassed++;
        }

        // Single copy only (try just noisy1)
        const singleResult = decodeHeaderV3FECSoft(noisy1);
        if (singleResult.success && arraysEqual(singleResult.data, headerFrame)) {
          singlePassed++;
        }
      }

      record('Header', 'soft combined (σ=0.30)', combinedPassed, trials);
      record('Header', 'soft single (σ=0.30)', singlePassed, trials);

      // Combined should do at least as well
      expect(combinedPassed).toBeGreaterThanOrEqual(singlePassed);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Layer 5: Full Pipeline Roundtrip
  // ═══════════════════════════════════════════════════════════════════════════

  describe('Full pipeline stress', () => {
    for (const payloadSize of [16, 64, 128]) {
      describe(`payload ${payloadSize} bytes`, () => {
        const sessionId = 0xABCD;
        const payload = new Uint8Array(payloadSize);
        for (let i = 0; i < payloadSize; i++) payload[i] = (i * 13 + 42) % 256;

        const dataFrame = createDataFrame(sessionId, 1, payload);
        const fecEncoded = encodeDataV3FEC(dataFrame);

        for (const ber of [0.01, 0.03, 0.05, 0.07, 0.10]) {
          it(`should survive ${(ber * 100).toFixed(0)}% BER`, () => {
            const { passed, total } = runTrials(TRIALS, () => {
              const corrupted = corruptBits(fecEncoded, ber);
              const decoded = decodeDataV3FEC(corrupted, payloadSize);
              if (!decoded.success) return false;

              const parsed = parseDataFrame(decoded.data);
              if (!parsed || !parsed.crcValid) return false;

              return arraysEqual(parsed.payload, payload);
            });

            record('Pipeline', `${payloadSize}B @ ${(ber * 100).toFixed(0)}% BER`, passed, total,
              passed >= total / 2 ? 'pass' : 'FAIL');

            // Only assert at very low BER
            if (ber <= 0.01) {
              expect(passed).toBeGreaterThanOrEqual(Math.floor(total * 0.3));
            }
          });
        }
      });
    }

    it('should survive interleaved BER with full pipeline', () => {
      const payload = new Uint8Array(64);
      for (let i = 0; i < 64; i++) payload[i] = i;

      const dataFrame = createDataFrame(0x1234, 1, payload);
      const fecEncoded = encodeDataV3FEC(dataFrame);
      const depth = calculateInterleaverDepth(fecEncoded.length);
      const interleaved = interleave(fecEncoded, depth);

      const { passed, total } = runTrials(TRIALS, () => {
        const corrupted = corruptBits(interleaved, 0.05);
        const deinterleavedCorrupted = deinterleave(corrupted, depth, fecEncoded.length);
        const decoded = decodeDataV3FEC(deinterleavedCorrupted, 64);
        if (!decoded.success) return false;

        const parsed = parseDataFrame(decoded.data);
        return parsed !== null && parsed.crcValid && arraysEqual(parsed.payload, payload);
      });

      record('Pipeline', '64B interleaved 5% BER', passed, total);
      // Observational — 5% BER after interleaving may still be too much
    });
  });
});

// ─── Utility ─────────────────────────────────────────────────────────────────

function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
