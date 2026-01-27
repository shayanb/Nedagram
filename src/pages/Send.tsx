import { useState, useCallback } from 'preact/hooks';
import { signal } from '@preact/signals';
import { useI18n } from '../i18n';
import { TextInput } from '../components/TextInput';
import { FileUpload } from '../components/FileUpload';
import { Button } from '../components/Button';
import { ProgressBar } from '../components/ProgressBar';
import { QRDisplay } from '../components/QRDisplay';
import { ChecksumDisplay } from '../components/ChecksumDisplay';
import { encodeString, checkPayloadSize, estimateEncode, type EncodeResult } from '../encode';
import { playAudio, stopAudio, pauseAudio, isPlaying, getCurrentTime } from '../audio/player';
import { downloadWAV } from '../lib/wav';
import { LIMITS, getAudioMode, setAudioMode, type AudioMode } from '../utils/constants';
import { formatBytes, formatDuration, stringToBytes } from '../utils/helpers';
import { calculatePasswordStrength, getPasswordStrengthLabel } from '../lib/crypto';
import './Send.css';

type SendState = 'idle' | 'encoding' | 'ready' | 'playing';

const sendState = signal<SendState>('idle');
const encodeResult = signal<EncodeResult | null>(null);
const errorMessage = signal<string | null>(null);
const playbackProgress = signal<number>(0);
const audioMode = signal<AudioMode>(getAudioMode());
const isResultStale = signal(false);

export function Send() {
  const { t } = useI18n();
  const [inputText, setInputText] = useState('');
  const [fileName, setFileName] = useState<string | null>(null);
  const [encryptEnabled, setEncryptEnabled] = useState(false);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  const inputBytes = stringToBytes(inputText).length;
  const sizeCheck = inputBytes > 0 ? checkPayloadSize(stringToBytes(inputText)) : null;
  const estimate = inputBytes > 0 ? estimateEncode(inputBytes) : null;

  const canEncode = inputText.length > 0 && (sizeCheck?.valid ?? true) && (!encryptEnabled || password.length > 0);
  // Show QR for small payloads - when encrypted, only show after encoding (with ciphertext)
  const showInputQR = inputBytes > 0 && inputBytes <= LIMITS.QR_MAX_BYTES && !encryptEnabled && sendState.value === 'idle';
  const passwordStrength = encryptEnabled && password.length > 0 ? calculatePasswordStrength(password) : 0;
  const strengthLabel = getPasswordStrengthLabel(passwordStrength);

  const handleFileSelect = useCallback((content: string, name: string) => {
    setInputText(content);
    setFileName(name);
    // Mark result as stale when file is loaded
    if (encodeResult.value) {
      isResultStale.value = true;
    }
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!canEncode) return;

    sendState.value = 'encoding';
    errorMessage.value = null;

    try {
      const result = await encodeString(inputText, {
        password: encryptEnabled ? password : undefined,
      });
      encodeResult.value = result;
      isResultStale.value = false;
      sendState.value = 'ready';
    } catch (err) {
      errorMessage.value = err instanceof Error ? err.message : 'Encoding failed';
      sendState.value = 'idle';
    }
  }, [inputText, canEncode, encryptEnabled, password]);

  const handlePlay = useCallback(async () => {
    if (!encodeResult.value) return;

    if (isPlaying()) {
      pauseAudio();
      sendState.value = 'ready';
      playbackProgress.value = 0;
    } else {
      sendState.value = 'playing';
      playbackProgress.value = 0;

      // Await is important for iOS - AudioContext.resume() is async
      await playAudio(
        encodeResult.value.audio,
        encodeResult.value.sampleRate,
        (state) => {
          sendState.value = state.isPlaying ? 'playing' : 'ready';
          if (state.duration > 0) {
            playbackProgress.value = Math.min(100, (state.currentTime / state.duration) * 100);
          }
        },
        () => {
          sendState.value = 'ready';
          playbackProgress.value = 0;
        }
      );
    }
  }, []);

  const handleDownload = useCallback(() => {
    if (!encodeResult.value) return;

    const filename = fileName
      ? fileName.replace(/\.[^.]+$/, '') + '.wav'
      : 'nedagram.wav';

    downloadWAV(encodeResult.value.audio, encodeResult.value.sampleRate, filename);
  }, [fileName]);

  const handleClear = useCallback(() => {
    stopAudio();
    setInputText('');
    setFileName(null);
    setEncryptEnabled(false);
    setPassword('');
    setShowPassword(false);
    sendState.value = 'idle';
    encodeResult.value = null;
    errorMessage.value = null;
    isResultStale.value = false;
  }, []);

  const handleEncryptToggle = useCallback((enabled: boolean) => {
    setEncryptEnabled(enabled);
    if (!enabled) {
      setPassword('');
    }
    // Mark result as stale when encryption toggle changes
    if (encodeResult.value) {
      isResultStale.value = true;
    }
  }, []);

  const handlePasswordChange = useCallback((newPassword: string) => {
    setPassword(newPassword);
    // Mark result as stale when password changes
    if (encodeResult.value) {
      isResultStale.value = true;
    }
  }, []);

  const handleTextChange = useCallback((newText: string) => {
    setInputText(newText);
    // Mark result as stale when text changes
    if (encodeResult.value) {
      isResultStale.value = true;
    }
  }, []);

  const handleModeChange = useCallback((mode: AudioMode) => {
    setAudioMode(mode);
    audioMode.value = mode;
    // Mark result as stale when mode changes
    if (encodeResult.value) {
      isResultStale.value = true;
    }
  }, []);


  return (
    <div class="send-page">
      <h2 class="page-title">{t.send.title}</h2>

      <div class="settings-row">
        <div class="setting-group">
          <span class="setting-label">Mode</span>
          <div class="mode-toggle compact">
            <button
              class={`mode-btn ${audioMode.value === 'phone' ? 'active' : ''}`}
              onClick={() => handleModeChange('phone')}
              title="Standard phone calls (300-3400 Hz)"
            >
              Phone
            </button>
            <button
              class={`mode-btn ${audioMode.value === 'wideband' ? 'active' : ''}`}
              onClick={() => handleModeChange('wideband')}
              title="HD Voice or direct (faster)"
            >
              Wideband
            </button>
          </div>
        </div>

      </div>

      <div class="input-section">
        <TextInput
          value={inputText}
          onChange={handleTextChange}
          label={t.send.inputLabel}
          placeholder={t.send.inputPlaceholder}
          multiline
          rows={8}
          disabled={sendState.value === 'encoding'}
        />

        <div class="input-actions">
          <FileUpload
            onFileSelect={handleFileSelect}
            label={t.send.uploadButton}
            disabled={sendState.value === 'encoding'}
          />
          {fileName && <span class="file-name">{fileName}</span>}

          <div class="encrypt-inline">
            <label class="encrypt-toggle">
              <input
                type="checkbox"
                checked={encryptEnabled}
                onChange={(e) => handleEncryptToggle((e.target as HTMLInputElement).checked)}
              />
              <span class="encrypt-label">{t.send.encrypt}</span>
            </label>

            {encryptEnabled && (
              <div class="password-wrapper">
                <div class="password-input-container">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    class="password-input"
                    value={password}
                    onInput={(e) => handlePasswordChange((e.target as HTMLInputElement).value)}
                    placeholder={t.send.passwordPlaceholder}
                    autocapitalize="off"
                    autocorrect="off"
                    autocomplete="off"
                    spellcheck={false}
                  />
                  <button
                    type="button"
                    class="password-toggle"
                    onClick={() => setShowPassword(!showPassword)}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? (
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
                {password.length > 0 && (
                  <div class={`password-strength-bar strength-${strengthLabel}`} />
                )}
              </div>
            )}
          </div>
        </div>

        {sizeCheck?.warning && (
          <div class="warning-message">{t.send.largeWarning}</div>
        )}

        {sizeCheck && !sizeCheck.valid && (
          <div class="error-message">{t.send.tooLarge}</div>
        )}

        {errorMessage.value && (
          <div class="error-message">{errorMessage.value}</div>
        )}
      </div>

      <div class="action-section">
        <Button
          onClick={handleGenerate}
          disabled={!canEncode || sendState.value === 'encoding' || (encodeResult.value !== null && !isResultStale.value)}
          fullWidth
        >
          {sendState.value === 'encoding' ? '...' : t.send.generateButton}
        </Button>

        {inputBytes > 0 && (
          <div class="input-stats">
            <span>{formatBytes(inputBytes)}</span>
            {estimate && <span>{formatDuration(estimate.estimatedDuration)}</span>}
            {estimate && <span>{estimate.estimatedFrames} {t.send.frames}</span>}
          </div>
        )}
      </div>

      {encodeResult.value && (
        <div class={`result-section ${isResultStale.value ? 'stale' : ''}`}>
          <div class="audio-controls">
            <Button
              onClick={handlePlay}
              variant={sendState.value === 'playing' ? 'secondary' : 'primary'}
            >
              {sendState.value === 'playing' ? t.send.pauseButton : t.send.playButton}
            </Button>

            <Button onClick={handleDownload} variant="secondary">
              {t.send.downloadButton}
            </Button>

            <Button onClick={handleClear} variant="ghost">
              Clear
            </Button>

            {encodeResult.value.stats.encrypted && (
              <span class="encrypted-badge">{t.send.encrypted}</span>
            )}
          </div>

          <div class="result-stats">
            <div class="stat">
              <span class="stat-label">{t.send.duration}</span>
              <span class="stat-value">{formatDuration(encodeResult.value.durationSeconds)}</span>
            </div>
            <div class="stat">
              <span class="stat-label">{t.send.fileSize}</span>
              <span class="stat-value">{formatBytes(encodeResult.value.audio.length * 2)}</span>
            </div>
            <div class="stat">
              <span class="stat-label">{t.send.frames}</span>
              <span class="stat-value">{encodeResult.value.stats.frameCount}</span>
            </div>
          </div>

          {sendState.value === 'playing' && (
            <ProgressBar value={playbackProgress.value} label={`Playing... ${Math.round(playbackProgress.value)}%`} />
          )}

          <ChecksumDisplay
            checksum={encodeResult.value.checksum}
            label={t.send.checksumLabel}
          />
        </div>
      )}

      {showInputQR && inputText && (
        <div class="qr-section">
          <QRDisplay data={inputText} title={t.send.qrTitle} />
        </div>
      )}
    </div>
  );
}
