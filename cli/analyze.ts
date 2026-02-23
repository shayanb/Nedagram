/**
 * CLI Analyze Command
 *
 * Reads a WAV file and reports signal quality diagnostics
 * without attempting a full decode. Useful for diagnosing
 * why a decode might fail.
 *
 * Enhanced with:
 * - Frequency offset estimation from calibration tones
 * - Per-symbol spectral dump for header region
 * - Frequency-compensated comparison showing symbol corrections
 */

import { parseWavFile } from './wav-io.js';
import { AUDIO, PHONE_MODE, WIDEBAND_MODE, setAudioMode, TONE_FREQUENCIES, type AudioMode } from '../src/utils/constants.js';
import { ChirpDetector } from '../src/lib/chirp.js';
import { detectToneSoft, averageConfidence, measureSignalQuality, type SoftDetectionResult } from '../src/decode/soft-decision.js';
import { FrequencyOffsetTracker, type FrequencyOffsetResult, type ToneMeasurement } from '../src/decode/freq-offset.js';

interface AnalyzeOptions {
  json?: boolean;
  quiet?: boolean;
}

interface SymbolDump {
  symbolIndex: number;
  hardDecision: number;
  confidence: number;
  softValues: number[];
  peakFrequencies: number[];
  compensatedDecision?: number;
}

interface AnalyzeResult {
  file: string;
  duration: number;
  sampleRate: number;
  chirpDetected: boolean;
  detectedMode: AudioMode | null;
  signalQuality: number;
  averageConfidence: number;
  estimatedSymbolErrorRate: number;
  peakEnergy: number;
  recommendation: string;
  frequencyOffset?: {
    offsetHz: number;
    confidence: number;
    measurements: ToneMeasurement[];
  };
  headerSymbolDump?: SymbolDump[];
  symbolsFlipped?: number;
  totalHeaderSymbols?: number;
}

export async function analyzeCommand(
  filePath: string,
  options: AnalyzeOptions
): Promise<void> {
  const log = options.json ? () => {} : console.error.bind(console);

  // Suppress chirp detector logs
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    const msg = args[0];
    if (typeof msg === 'string' && (msg.startsWith('[ChirpDetector]') || msg.startsWith('[Decoder]') || msg.startsWith('[Audio]'))) {
      return;
    }
    originalLog.apply(console, args);
  };

  try {
    log(`Analyzing ${filePath}...`);
    const { samples, sampleRate } = parseWavFile(filePath);
    const duration = samples.length / sampleRate;
    log(`Sample rate: ${sampleRate} Hz, Duration: ${duration.toFixed(1)}s`);
    log('');

    // Step 1: Detect chirp/preamble
    const chirpDetector = new ChirpDetector(sampleRate, 0.3);
    const chunkSize = Math.floor(sampleRate * 0.05); // 50ms chunks

    let chirpDetected = false;
    let chirpEndSample = -1;

    for (let offset = 0; offset < samples.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, samples.length);
      const chunk = samples.slice(offset, end);
      const result = chirpDetector.addSamples(chunk);
      if (result.detected) {
        chirpDetected = true;
        chirpEndSample = result.chirpEndSample;
        break;
      }
    }

    if (chirpDetected) {
      log('Preamble chirp detected!');
    } else {
      log('Chirp not detected by matched filter, trying pattern search...');
    }

    // Step 2: Extract symbols with soft detection for both modes and find calibration
    // If chirp detected, start from chirp end. Otherwise scan from beginning.
    const symbolSamples = Math.floor((AUDIO.SYMBOL_DURATION_MS / 1000) * sampleRate);
    const calibStartSample = chirpDetected ? chirpEndSample : 0;

    // Try both modes
    const modes: { mode: AudioMode; calib: number[]; sync: number[]; calibRepeats: number; maxTone: number }[] = [
      {
        mode: 'phone',
        calib: PHONE_MODE.CALIBRATION_TONES,
        sync: PHONE_MODE.SYNC_PATTERN,
        calibRepeats: PHONE_MODE.CALIBRATION_REPEATS,
        maxTone: PHONE_MODE.NUM_TONES - 1,
      },
      {
        mode: 'wideband',
        calib: WIDEBAND_MODE.CALIBRATION_TONES,
        sync: WIDEBAND_MODE.SYNC_PATTERN,
        calibRepeats: WIDEBAND_MODE.CALIBRATION_REPEATS,
        maxTone: WIDEBAND_MODE.NUM_TONES - 1,
      },
    ];

    // Extract soft symbols from chirp end onwards
    const maxSymbols = Math.min(500, Math.floor((samples.length - calibStartSample) / symbolSamples));
    const softResults: SoftDetectionResult[] = [];

    for (let i = 0; i < maxSymbols; i++) {
      const start = calibStartSample + i * symbolSamples;
      const symbolChunk = samples.slice(start, start + symbolSamples);
      if (symbolChunk.length < symbolSamples * 0.8) break;
      softResults.push(detectToneSoft(symbolChunk, sampleRate));
    }

    const hardSymbols = softResults.map(r => r.hardDecision);

    // Step 3: Match calibration + sync pattern
    let detectedMode: AudioMode | null = null;
    let bestMatchRatio = 0;
    let calibErrors = 0;
    let totalCalibSymbols = 0;
    let syncEndIdx = 0;
    let bestCalibStartOffset = 0;

    for (const { mode, calib, sync, calibRepeats, maxTone } of modes) {
      const fullCalib: number[] = [];
      for (let r = 0; r < calibRepeats; r++) {
        fullCalib.push(...calib);
      }
      const fullPattern = [...fullCalib, ...sync];

      // Search for pattern: narrow window if chirp detected, full scan otherwise
      const searchStart = chirpDetected ? -3 : 0;
      const searchEnd = chirpDetected ? 3 : hardSymbols.length - fullPattern.length;
      for (let startIdx = searchStart; startIdx <= searchEnd; startIdx++) {
        if (startIdx < 0 || startIdx + fullPattern.length > hardSymbols.length) continue;

        let matchCount = 0;
        const tolerance = maxTone > 10 ? 2 : 1;
        for (let i = 0; i < fullPattern.length; i++) {
          if (hardSymbols[startIdx + i] === fullPattern[i] ||
              Math.abs(hardSymbols[startIdx + i] - fullPattern[i]) <= tolerance) {
            matchCount++;
          }
        }

        const ratio = matchCount / fullPattern.length;
        if (ratio > bestMatchRatio) {
          bestMatchRatio = ratio;
          if (ratio >= 0.5) {
            detectedMode = mode;
            calibErrors = fullPattern.length - matchCount;
            totalCalibSymbols = fullPattern.length;
            syncEndIdx = startIdx + fullPattern.length;
            bestCalibStartOffset = startIdx;
          }
        }
      }
    }

    // Bail out if no pattern found at all
    if (!detectedMode) {
      const result: AnalyzeResult = {
        file: filePath,
        duration,
        sampleRate,
        chirpDetected,
        detectedMode: null,
        signalQuality: 0,
        averageConfidence: 0,
        estimatedSymbolErrorRate: 1.0,
        peakEnergy: computePeakEnergy(samples),
        recommendation: 'No calibration/sync pattern detected. The file may not contain a Nedagram signal, or the signal is too distorted.',
      };
      outputResult(result, options, log);
      return;
    }

    log(`Detected ${detectedMode} mode (pattern match: ${(bestMatchRatio * 100).toFixed(0)}%)`);

    // Step 4: Frequency offset estimation from calibration tones
    let freqOffsetResult: FrequencyOffsetResult | undefined;

    if (detectedMode) {
      // Set the detected mode so TONE_FREQUENCIES is correct
      setAudioMode(detectedMode);

      const modeConfig = detectedMode === 'phone' ? PHONE_MODE : WIDEBAND_MODE;
      const calibRepeats = modeConfig.CALIBRATION_REPEATS;
      const calibTones = modeConfig.CALIBRATION_TONES;
      const calibSymbolCount = calibTones.length * calibRepeats;
      const calibSampleLength = calibSymbolCount * symbolSamples;

      // Extract calibration audio from the right position
      const calibAudioStart = calibStartSample + bestCalibStartOffset * symbolSamples;
      if (calibAudioStart + calibSampleLength <= samples.length) {
        const calibAudio = samples.slice(calibAudioStart, calibAudioStart + calibSampleLength);

        // Build expected tone sequence
        const expectedTones: number[] = [];
        for (let r = 0; r < calibRepeats; r++) {
          expectedTones.push(...calibTones);
        }

        // Use wide search window for phone codecs
        const tracker = new FrequencyOffsetTracker(200);
        freqOffsetResult = tracker.estimateOffset(calibAudio, sampleRate, expectedTones, symbolSamples);
      }
    }

    // Step 5: Per-symbol spectral dump for header region
    let headerSymbolDump: SymbolDump[] | undefined;
    let symbolsFlipped = 0;
    let totalHeaderSymbols = 0;

    if (detectedMode && syncEndIdx > 0 && freqOffsetResult) {
      // Set mode for correct TONE_FREQUENCIES
      setAudioMode(detectedMode);

      // Extract ~30 header symbols (more than needed for analysis)
      const numHeaderDumpSymbols = Math.min(30, softResults.length - syncEndIdx);
      totalHeaderSymbols = numHeaderDumpSymbols;
      headerSymbolDump = [];

      for (let i = 0; i < numHeaderDumpSymbols; i++) {
        const symbolIdx = syncEndIdx + i;
        if (symbolIdx >= softResults.length) break;

        const original = softResults[symbolIdx];

        // Re-detect with frequency offset compensation
        const symbolStart = calibStartSample + symbolIdx * symbolSamples;
        const symbolChunk = samples.slice(symbolStart, symbolStart + symbolSamples);
        let compensatedDecision: number | undefined;

        if (symbolChunk.length >= symbolSamples * 0.8 && Math.abs(freqOffsetResult.offsetHz) >= 5) {
          const compensated = detectToneSoft(symbolChunk, sampleRate, freqOffsetResult.offsetHz);
          compensatedDecision = compensated.hardDecision;
          if (compensatedDecision !== original.hardDecision) {
            symbolsFlipped++;
          }
        }

        headerSymbolDump.push({
          symbolIndex: i,
          hardDecision: original.hardDecision,
          confidence: original.confidence,
          softValues: Array.from(original.softValues),
          peakFrequencies: original.peakFrequencies ?? [],
          compensatedDecision,
        });
      }
    }

    // Step 6: Compute metrics on post-sync symbols (actual data)
    const dataSymbols = syncEndIdx > 0 ? softResults.slice(syncEndIdx) : softResults;
    const quality = measureSignalQuality(dataSymbols);
    const avgConf = averageConfidence(dataSymbols);
    const symbolErrorRate = totalCalibSymbols > 0 ? calibErrors / totalCalibSymbols : 1.0;
    const peakEnergy = computePeakEnergy(samples);

    // Step 7: Recommendation
    let recommendation: string;
    if (quality >= 0.7 && avgConf >= 0.6) {
      recommendation = 'Signal quality is good. Standard decode should work.';
    } else if (quality >= 0.4 && avgConf >= 0.3) {
      recommendation = 'Signal quality is marginal. Soft-decision decoding may recover data. Try: nedagram decode <file>';
    } else if (quality >= 0.15 || avgConf >= 0.15) {
      recommendation = 'Signal quality is poor. Try: nedagram decode --salvage <file>';
    } else {
      recommendation = 'Signal quality is very weak. Recovery is unlikely, but you can try: nedagram decode --salvage <file>';
    }

    const result: AnalyzeResult = {
      file: filePath,
      duration,
      sampleRate,
      chirpDetected,
      detectedMode,
      signalQuality: quality,
      averageConfidence: avgConf,
      estimatedSymbolErrorRate: symbolErrorRate,
      peakEnergy,
      recommendation,
      frequencyOffset: freqOffsetResult ? {
        offsetHz: freqOffsetResult.offsetHz,
        confidence: freqOffsetResult.confidence,
        measurements: freqOffsetResult.measurements,
      } : undefined,
      headerSymbolDump,
      symbolsFlipped,
      totalHeaderSymbols,
    };

    outputResult(result, options, log);
  } catch (error) {
    if (options.json) {
      console.log(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
      process.exit(1);
    }
    console.error('Error:', error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    console.log = originalLog;
  }
}

function computePeakEnergy(samples: Float32Array): number {
  let peak = 0;
  // Sample every 100th value for speed
  for (let i = 0; i < samples.length; i += 100) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  return peak;
}

function outputResult(result: AnalyzeResult, options: AnalyzeOptions, log: (...args: unknown[]) => void): void {
  if (options.json) {
    console.log(JSON.stringify({ success: true, ...result }, null, 2));
    return;
  }

  log('Signal Analysis');
  log('════════════════════════════════════════');
  log(`  Preamble:          ${result.chirpDetected ? 'Detected' : 'Not found'}`);
  log(`  Mode:              ${result.detectedMode ?? 'Unknown'}`);
  log(`  Signal Quality:    ${(result.signalQuality * 100).toFixed(0)}%`);
  log(`  Avg Confidence:    ${(result.averageConfidence * 100).toFixed(0)}%`);
  log(`  Symbol Error Rate: ${(result.estimatedSymbolErrorRate * 100).toFixed(1)}%`);
  log(`  Peak Energy:       ${result.peakEnergy.toFixed(3)}`);
  log('════════════════════════════════════════');

  // Frequency offset section
  if (result.frequencyOffset) {
    log('');
    log('Frequency Offset Analysis');
    log('════════════════════════════════════════');
    const offset = result.frequencyOffset;
    log(`  Estimated offset:  ${offset.offsetHz >= 0 ? '+' : ''}${offset.offsetHz.toFixed(1)} Hz (confidence: ${(offset.confidence * 100).toFixed(0)}%)`);
    for (const m of offset.measurements) {
      const sign = m.errorHz >= 0 ? '+' : '';
      log(`  Tone ${m.expectedHz} Hz:  measured ${m.measuredHz.toFixed(0)} Hz  (${sign}${m.errorHz.toFixed(0)} Hz)  mag: ${m.magnitude.toFixed(2)}`);
    }
    log('════════════════════════════════════════');
  }

  // Header symbol dump
  if (result.headerSymbolDump && result.headerSymbolDump.length > 0) {
    log('');
    log('Header Symbols');
    log('════════════════════════════════════════');

    const hasCompensated = result.headerSymbolDump.some(s => s.compensatedDecision !== undefined);

    for (const sym of result.headerSymbolDump) {
      const softStr = `[${sym.softValues.join(',')}]`;
      const peakStr = sym.peakFrequencies.length > 0
        ? ` peaks=[${sym.peakFrequencies.map(f => f.toFixed(0)).join(',')}]Hz`
        : '';
      let line = `  #${String(sym.symbolIndex).padStart(2)}: tone=${sym.hardDecision} conf=${sym.confidence.toFixed(2)} soft=${softStr}${peakStr}`;

      if (hasCompensated && sym.compensatedDecision !== undefined) {
        const changed = sym.compensatedDecision !== sym.hardDecision;
        line += changed
          ? ` -> compensated=${sym.compensatedDecision} ***`
          : ` -> compensated=${sym.compensatedDecision}`;
      }
      log(line);
    }

    if (hasCompensated && result.symbolsFlipped !== undefined && result.totalHeaderSymbols !== undefined) {
      log('');
      log(`  Symbols changed by offset compensation: ${result.symbolsFlipped}/${result.totalHeaderSymbols}`);
    }

    log('════════════════════════════════════════');
  }

  log('');
  log(`  ${result.recommendation}`);
  log('');
}
