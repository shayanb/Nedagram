import { useState, useCallback, useRef } from 'preact/hooks';
import { signal } from '@preact/signals';
import { useI18n, interpolate } from '../i18n';
import { Button } from '../components/Button';
import { ProgressBar } from '../components/ProgressBar';
import { SignalMeter } from '../components/SignalMeter';
import { ChecksumDisplay } from '../components/ChecksumDisplay';
import { QRDisplay } from '../components/QRDisplay';
import { Decoder, type DecodeResult, type DecodeState } from '../decode';
import { startRecording, stopRecording, requestMicrophonePermission, getRecordedAudio, clearRecordedAudio } from '../audio/recorder';
import { getSampleRate } from '../audio/context';
import { downloadWAV, parseAudioFile } from '../lib/wav';
import { formatBytes } from '../utils/helpers';
import { LIMITS } from '../utils/constants';
import './Receive.css';

const decoder = signal<Decoder | null>(null);
const receiveState = signal<DecodeState>('idle');
const result = signal<DecodeResult | null>(null);
const errorMessage = signal<string | null>(null);
const signalLevel = signal(0);
const debugInfo = signal('');
const copied = signal(false);
const chirpDetected = signal(false);
const hasAudioRecording = signal(false);
const needsPassword = signal(false);
const decryptPassword = signal('');
const showDecryptPassword = signal(false);
const isProcessingFile = signal(false);
const fileProgress = signal(0);
const isDragging = signal(false);
const dragCounter = signal(0); // Track nested drag enter/leave events

export function Receive() {
  const { t } = useI18n();
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleStart = useCallback(async () => {
    errorMessage.value = null;
    result.value = null;
    debugInfo.value = 'Requesting microphone access...';
    chirpDetected.value = false;
    hasAudioRecording.value = false;
    setIsRequestingPermission(true);

    // Request permission on button click (required for iOS)
    const hasPermission = await requestMicrophonePermission();
    setIsRequestingPermission(false);

    if (!hasPermission) {
      errorMessage.value = t.errors.microphoneBlocked;
      debugInfo.value = '';
      return;
    }

    debugInfo.value = 'Starting...';

    const sampleRate = getSampleRate();
    console.log('[Receive] Starting with sample rate:', sampleRate);

    const dec = new Decoder(sampleRate);
    decoder.value = dec;

    dec.start(
      (decodeResult) => {
        console.log('[Receive] Decode complete!', decodeResult);
        result.value = decodeResult;
        receiveState.value = 'complete';
        hasAudioRecording.value = true;
        errorMessage.value = null; // Clear any error
        // Check if password is needed for encrypted data
        if (decodeResult.needsPassword) {
          needsPassword.value = true;
        }
        stopRecording();
      },
      (err) => {
        console.error('[Receive] Decode error:', err);
        errorMessage.value = err.message;
        receiveState.value = 'error';
        hasAudioRecording.value = true;
        stopRecording();
      }
    );

    receiveState.value = 'listening';

    try {
      await startRecording({
        onSamples: (samples) => {
          dec.processSamples(samples);
          const progress = dec.progress.value;
          signalLevel.value = progress.signalLevel;
          receiveState.value = progress.state;
          debugInfo.value = progress.debugInfo || '';
          if (progress.chirpDetected && !chirpDetected.value) {
            chirpDetected.value = true;
          }
        },
        onError: (err) => {
          console.error('[Receive] Recording error:', err);
          errorMessage.value = err.message;
          receiveState.value = 'error';
          hasAudioRecording.value = true;
        },
        onLevelChange: (level) => {
          signalLevel.value = level;
        },
      });
    } catch (err) {
      console.error('[Receive] Start error:', err);
      errorMessage.value = t.errors.microphoneBlocked;
      receiveState.value = 'error';
    }
  }, [t]);

  const handleStop = useCallback(() => {
    stopRecording();
    decoder.value?.stop();
    receiveState.value = 'idle';
    debugInfo.value = '';
    hasAudioRecording.value = true; // Keep recording available for save
  }, []);

  const handleCopy = useCallback(async () => {
    if (!result.value) return;

    try {
      await navigator.clipboard.writeText(result.value.text);
      copied.value = true;
      setTimeout(() => {
        copied.value = false;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }, []);

  const handleSave = useCallback(() => {
    if (!result.value) return;

    const blob = new Blob([result.value.text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'received.txt';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, []);

  const handleClear = useCallback(() => {
    result.value = null;
    errorMessage.value = null;
    receiveState.value = 'idle';
    debugInfo.value = '';
    chirpDetected.value = false;
    hasAudioRecording.value = false;
    needsPassword.value = false;
    decryptPassword.value = '';
    showDecryptPassword.value = false;
    clearRecordedAudio();
  }, []);

  const handleDecrypt = useCallback(async () => {
    if (!decoder.value || !decryptPassword.value) return;

    errorMessage.value = null;

    try {
      await decoder.value.retryWithPassword(decryptPassword.value);
      // If successful, onComplete will be called with decrypted result
      // Check if result updated
      if (result.value && !result.value.needsPassword) {
        needsPassword.value = false;
        decryptPassword.value = '';
      }
    } catch (err) {
      console.error('[Receive] Decryption error:', err);
      errorMessage.value = t.receive.decryptionFailed;
    }
  }, [t]);

  const handleSaveAudio = useCallback(() => {
    const recording = getRecordedAudio();
    if (!recording) return;

    downloadWAV(recording.samples, recording.sampleRate, 'nedagram-recording.wav');
  }, []);

  const handleFileUpload = useCallback(async (file: File) => {
    if (!file) return;

    // Reset state
    errorMessage.value = null;
    result.value = null;
    debugInfo.value = t.receive.processingFile;
    chirpDetected.value = false;
    hasAudioRecording.value = false;
    isProcessingFile.value = true;
    fileProgress.value = 0;

    try {
      // Parse the audio file
      debugInfo.value = t.receive.decodingAudio;
      const { samples, sampleRate } = await parseAudioFile(file);

      console.log('[Receive] Loaded audio file:', file.name, 'samples:', samples.length, 'rate:', sampleRate);
      debugInfo.value = `Loaded ${(samples.length / sampleRate).toFixed(1)}s of audio`;

      // Create decoder
      const dec = new Decoder(sampleRate);
      decoder.value = dec;

      dec.start(
        (decodeResult) => {
          console.log('[Receive] File decode complete!', decodeResult);
          result.value = decodeResult;
          receiveState.value = 'complete';
          isProcessingFile.value = false;
          errorMessage.value = null; // Clear any error that was set prematurely
          if (decodeResult.needsPassword) {
            needsPassword.value = true;
          }
        },
        (err) => {
          console.error('[Receive] File decode error:', err);
          errorMessage.value = err.message;
          receiveState.value = 'error';
          isProcessingFile.value = false;
        }
      );

      receiveState.value = 'detecting_preamble';

      // Process audio in chunks to avoid blocking UI
      const chunkSize = 4096;
      const totalChunks = Math.ceil(samples.length / chunkSize);

      for (let i = 0; i < samples.length; i += chunkSize) {
        const chunk = samples.subarray(i, Math.min(i + chunkSize, samples.length));
        dec.processSamples(chunk);

        // Update progress
        const progress = dec.progress.value;
        signalLevel.value = progress.signalLevel;
        receiveState.value = progress.state;
        debugInfo.value = progress.debugInfo || '';
        fileProgress.value = ((i / samples.length) * 100);

        if (progress.chirpDetected && !chirpDetected.value) {
          chirpDetected.value = true;
        }

        // Check if complete or error
        if (progress.state === 'complete' || progress.state === 'error') {
          break;
        }

        // Yield to UI every few chunks
        if ((i / chunkSize) % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }

      // If not complete yet, finalize
      // Note: Check result.value as well since the success callback may have fired
      if (receiveState.value !== 'complete' && receiveState.value !== 'error' && !result.value) {
        debugInfo.value = 'Processing complete - no valid transmission found';
        errorMessage.value = t.receive.noTransmissionFound;
        receiveState.value = 'error';
      }

      isProcessingFile.value = false;
      fileProgress.value = 100;

    } catch (err) {
      console.error('[Receive] File processing error:', err);
      errorMessage.value = (err as Error).message || t.receive.fileError;
      receiveState.value = 'error';
      isProcessingFile.value = false;
    }
  }, [t]);

  const handleFileInputChange = useCallback((e: Event) => {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (file) {
      handleFileUpload(file);
      // Reset input so same file can be selected again
      input.value = '';
    }
  }, [handleFileUpload]);

  const handleUploadClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.value++;
    isDragging.value = true;
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.value--;
    if (dragCounter.value === 0) {
      isDragging.value = false;
    }
  }, []);

  const handleDrop = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounter.value = 0;
    isDragging.value = false;

    const file = e.dataTransfer?.files?.[0];
    if (file && (file.type.startsWith('audio/') || file.name.match(/\.(wav|mp3|m4a|ogg|webm)$/i))) {
      handleFileUpload(file);
    }
  }, [handleFileUpload]);

  const isListening = receiveState.value !== 'idle' && receiveState.value !== 'complete' && receiveState.value !== 'error';
  const progress = decoder.value?.progress.value;

  const getStatusMessage = () => {
    switch (receiveState.value) {
      case 'listening':
        return t.receive.waitingForSignal;
      case 'detecting_preamble':
        return t.receive.detectingPreamble;
      case 'receiving_header':
        return t.receive.receivingHeader;
      case 'receiving_data':
        return t.receive.receivingData;
      case 'complete':
        return t.receive.complete;
      default:
        return '';
    }
  };

  const getStateColor = () => {
    switch (receiveState.value) {
      case 'receiving_header':
      case 'receiving_data':
        return 'var(--color-accent)';
      case 'complete':
        return 'var(--color-success)';
      case 'error':
        return 'var(--color-error)';
      default:
        return 'var(--color-text-muted)';
    }
  };

  return (
    <div
      class={`receive-page ${isDragging.value ? 'dragging' : ''}`}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <h2 class="page-title">{t.receive.title}</h2>

      <p class="auto-detect-hint">
        {t.receive.autoDetectHint}
      </p>

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.ogg,.webm"
        style={{ display: 'none' }}
        onChange={handleFileInputChange}
      />

      <div class="control-section">
        {!isListening && receiveState.value !== 'complete' && !isProcessingFile.value ? (
          <>
            <Button onClick={handleStart} fullWidth disabled={isRequestingPermission}>
              {isRequestingPermission ? 'Requesting access...' : t.receive.listenButton}
            </Button>
            <button class="upload-btn" onClick={handleUploadClick}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              {t.receive.uploadAudio}
            </button>
            <p class="upload-hint">{t.receive.uploadHint}</p>
          </>
        ) : isListening ? (
          <Button onClick={handleStop} variant="secondary" fullWidth>
            {t.receive.stopButton}
          </Button>
        ) : isProcessingFile.value ? (
          <div class="processing-indicator">
            <div class="processing-spinner" />
            <span>{t.receive.processingFile}</span>
          </div>
        ) : null}
      </div>

      {/* Drag overlay */}
      {isDragging.value && (
        <div class="drag-overlay">
          <div class="drag-content">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            <span>{t.receive.dropToUpload}</span>
          </div>
        </div>
      )}

      {/* File processing progress */}
      {isProcessingFile.value && fileProgress.value > 0 && (
        <div class="file-progress">
          <ProgressBar value={fileProgress.value} label={`${t.receive.processingFile} ${fileProgress.value.toFixed(0)}%`} />
        </div>
      )}

      {isListening && (
        <div class="status-section">
          <div class="status-row">
            <SignalMeter level={signalLevel.value} label={t.receive.signalStrength} />
            <div class="status-indicator" style={{ color: getStateColor() }}>
              <span class="status-dot" style={{ backgroundColor: getStateColor() }} />
              {receiveState.value.replace('_', ' ')}
            </div>
          </div>

          {chirpDetected.value && (
            <div class="chirp-indicator">
              Preamble detected - audio starting from beginning
            </div>
          )}

          <div class="status-message">{getStatusMessage()}</div>

          {progress && progress.syncConfidence > 0 && receiveState.value === 'detecting_preamble' && (
            <ProgressBar
              value={progress.syncConfidence}
              label={`Sync detection: ${progress.syncConfidence.toFixed(0)}%`}
            />
          )}

          {progress?.signalWarning && (
            <div class="signal-warning">
              Poor signal quality - try moving closer, reducing background noise, or restarting
            </div>
          )}

          {debugInfo.value && !progress?.signalWarning && (
            <div class="debug-info">
              {debugInfo.value}
            </div>
          )}

          {progress && progress.totalFrames > 0 && (
            <>
              <ProgressBar
                value={(progress.framesReceived / progress.totalFrames) * 100}
                label={interpolate(t.receive.frameProgress, {
                  current: progress.framesReceived,
                  total: progress.totalFrames,
                })}
              />
            </>
          )}

          {progress && progress.symbolsReceived !== undefined && progress.symbolsReceived > 0 && (
            <div class="symbols-count">
              Symbols received: {progress.symbolsReceived}
            </div>
          )}
        </div>
      )}

      {errorMessage.value && !needsPassword.value && (
        <div class="error-section">
          <div class="error-message">{errorMessage.value}</div>
          <div class="error-actions">
            <Button onClick={handleStart} variant="secondary">
              {t.receive.tryAgain}
            </Button>
            {hasAudioRecording.value && (
              <Button onClick={handleSaveAudio} variant="ghost">
                {t.receive.saveAudio}
              </Button>
            )}
          </div>
          <p class="error-hint">{t.receive.errorHint}</p>
          <p class="debug-hint">
            Having issues? Use the debug log panel to copy info, then <a href="https://github.com/shayanb/nedagram/issues/new?template=bug_report.md" target="_blank" rel="noopener noreferrer">report a bug</a>.
          </p>
        </div>
      )}

      {result.value && needsPassword.value && (
        <div class="result-section password-section">
          <div class="result-header">
            <span class="result-status encrypted">{t.receive.encrypted}</span>
          </div>

          <p class="password-prompt">{t.receive.passwordPrompt}</p>

          <div class="password-input-wrapper">
            <div class="password-input-container">
              <input
                type={showDecryptPassword.value ? 'text' : 'password'}
                class="password-input"
                value={decryptPassword.value}
                onInput={(e) => { decryptPassword.value = (e.target as HTMLInputElement).value; }}
                placeholder={t.send.passwordPlaceholder}
                onKeyDown={(e) => { if (e.key === 'Enter') handleDecrypt(); }}
                autocapitalize="off"
                autocorrect="off"
                autocomplete="off"
                spellcheck={false}
              />
              <button
                type="button"
                class="password-toggle"
                onClick={() => { showDecryptPassword.value = !showDecryptPassword.value; }}
                title={showDecryptPassword.value ? 'Hide password' : 'Show password'}
              >
                {showDecryptPassword.value ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {errorMessage.value && (
            <div class="error-message">{errorMessage.value}</div>
          )}

          <div class="result-actions">
            <Button onClick={handleDecrypt} disabled={!decryptPassword.value}>
              {t.receive.decryptButton}
            </Button>
            {hasAudioRecording.value && (
              <Button onClick={handleSaveAudio} variant="secondary">
                {t.receive.saveAudio}
              </Button>
            )}
            <Button onClick={handleClear} variant="ghost">
              {t.receive.clear}
            </Button>
          </div>
        </div>
      )}

      {result.value && !needsPassword.value && (
        <div class="result-section">
          <div class="result-header">
            <span class="result-status success">{t.receive.complete}</span>
            <span class="result-size">{formatBytes(result.value.stats.originalSize)}</span>
            {result.value.encrypted && (
              <span class="encrypted-badge">{t.receive.encrypted}</span>
            )}
          </div>

          <div class="result-text">
            <pre>{result.value.text}</pre>
          </div>

          <div class="result-actions">
            <Button onClick={handleCopy}>
              {copied.value ? t.receive.copied : t.receive.copyButton}
            </Button>
            <Button onClick={handleSave} variant="secondary">
              {t.receive.saveButton}
            </Button>
            {hasAudioRecording.value && (
              <Button onClick={handleSaveAudio} variant="secondary">
                {t.receive.saveAudio}
              </Button>
            )}
            <Button onClick={handleClear} variant="ghost">
              {t.receive.clear}
            </Button>
          </div>

          <ChecksumDisplay
            checksum={result.value.checksum}
            label={t.send.checksumLabel}
          />


          {result.value.stats.originalSize <= LIMITS.QR_MAX_BYTES && (
            <div class="qr-section">
              <QRDisplay data={result.value.text} title={t.receive.scanToCopy} />
            </div>
          )}
        </div>
      )}

    </div>
  );
}
