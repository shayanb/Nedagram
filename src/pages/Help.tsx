import { useI18n } from '../i18n';
import { BUILD_VERSION, formatBuildTime } from '../utils/version';
import { getAudioMode, getFECMode } from '../utils/constants';
import './Help.css';

export function Help() {
  const { t } = useI18n();
  const mode = getAudioMode();
  const fecMode = getFECMode();

  return (
    <div class="help-page">
      <h2 class="page-title">{t.help.title}</h2>

      <section class="help-section">
        <h3>{t.help.gettingStarted}</h3>
        <p>{t.help.gettingStartedText}</p>
      </section>

      <section class="help-section">
        <h3>{t.help.sending}</h3>
        <ol class="help-list">
          {t.help.sendingSteps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </section>

      <section class="help-section">
        <h3>{t.help.receiving}</h3>
        <ol class="help-list">
          {t.help.receivingSteps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </section>

      <section class="help-section">
        <h3>{t.help.tips}</h3>
        <ul class="help-list tips">
          {t.help.tipsList.map((tip, i) => (
            <li key={i}>{tip}</li>
          ))}
        </ul>
      </section>

      <section class="help-section offline">
        <h3>{t.help.offlineDownload}</h3>
        <p>{t.help.offlineDownloadDesc}</p>
        <ol class="help-list">
          {t.help.offlineDownloadSteps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
        <p class="mode-note">{t.help.offlineDownloadNote}</p>
        <div class="offline-actions">
          {import.meta.env.PROD ? (
            <a href={`/nedagram-offline-${BUILD_VERSION}.zip`} download={`nedagram-offline-${BUILD_VERSION}.zip`} class="button primary">
              {t.help.downloadButton}
            </a>
          ) : (
            <span class="button primary disabled" title="Run 'npm run build' first">
              {t.help.downloadButton}
            </span>
          )}
          <a href="/README.html" target="_blank" class="button secondary">
            {t.help.offlineInstructions}
          </a>
        </div>
      </section>

      <section class="help-section modes">
        <h3>{t.help.transmissionModes}</h3>

        <h4>{t.help.audioMode}</h4>
        <p class="mode-note">{t.help.audioModeNote}</p>

        <div class="mode-card">
          <h5>{t.help.phoneMode}</h5>
          <p>{t.help.phoneModeDesc}</p>
          <ul class="mode-examples">
            {t.help.phoneModeExamples.map((example, i) => (
              <li key={i}>{example}</li>
            ))}
          </ul>
          <p class="mode-tradeoff">{t.help.phoneModeTradeoff}</p>
        </div>

        <div class="mode-card">
          <h5>{t.help.widebandMode}</h5>
          <p>{t.help.widebandModeDesc}</p>
          <ul class="mode-examples">
            {t.help.widebandModeExamples.map((example, i) => (
              <li key={i}>{example}</li>
            ))}
          </ul>
          <p class="mode-tradeoff">{t.help.widebandModeTradeoff}</p>
        </div>

        <h4>{t.help.fecMode}</h4>
        <p class="mode-note">{t.help.fecModeNote}</p>

        <div class="mode-card">
          <h5>{t.help.normalFec}</h5>
          <p>{t.help.normalFecDesc}</p>
          <ul class="mode-examples">
            {t.help.normalFecExamples.map((example, i) => (
              <li key={i}>{example}</li>
            ))}
          </ul>
          <p class="mode-tradeoff">{t.help.normalFecTradeoff}</p>
        </div>

        <div class="mode-card">
          <h5>{t.help.robustFec}</h5>
          <p>{t.help.robustFecDesc}</p>
          <ul class="mode-examples">
            {t.help.robustFecExamples.map((example, i) => (
              <li key={i}>{example}</li>
            ))}
          </ul>
          <p class="mode-tradeoff">{t.help.robustFecTradeoff}</p>
        </div>
      </section>

      <section class="help-section specs">
        <h3>{t.help.technicalSpecs}</h3>

        <h4>Phone Mode (300-3400 Hz)</h4>
        <dl class="spec-list">
          <dt>Modulation</dt>
          <dd>8-MFSK (3 bits per symbol)</dd>

          <dt>Frequency Range</dt>
          <dd>600 - 3050 Hz</dd>

          <dt>Symbol Duration</dt>
          <dd>50ms + 8ms guard</dd>

          <dt>Effective Bitrate</dt>
          <dd>~30-35 bps</dd>
        </dl>

        <h4>Wideband Mode (HD Voice)</h4>
        <dl class="spec-list">
          <dt>Modulation</dt>
          <dd>16-MFSK (4 bits per symbol)</dd>

          <dt>Frequency Range</dt>
          <dd>1800 - 5700 Hz</dd>

          <dt>Symbol Duration</dt>
          <dd>40ms + 5ms guard</dd>

          <dt>Effective Bitrate</dt>
          <dd>~50-60 bps</dd>
        </dl>

        <h4>Error Correction (Reed-Solomon)</h4>
        <dl class="spec-list">
          <dt>Normal Mode</dt>
          <dd>RS(n, n-16) - corrects up to 8 byte errors per frame</dd>

          <dt>Robust Mode</dt>
          <dd>RS(n, n-32) - corrects up to 16 byte errors per frame</dd>
        </dl>

        <h4>Encryption (Optional)</h4>
        <dl class="spec-list">
          <dt>Cipher</dt>
          <dd>ChaCha20-Poly1305 (AEAD)</dd>

          <dt>Key Derivation</dt>
          <dd>PBKDF2-SHA256 (100,000 iterations)</dd>

          <dt>Overhead</dt>
          <dd>44 bytes (16 salt + 12 nonce + 16 auth tag)</dd>
        </dl>

        <h4>Common Settings</h4>
        <dl class="spec-list">
          <dt>Header Format</dt>
          <dd>12 bytes compact (N1 magic, CRC16)</dd>

          <dt>Compression</dt>
          <dd>DEFLATE (automatic)</dd>

          <dt>Checksum</dt>
          <dd>SHA-256 (of original plaintext)</dd>

          <dt>Maximum Payload</dt>
          <dd>100 KB</dd>

          <dt>Preamble</dt>
          <dd>Warmup (200ms) + Chirp (800ms) + Calibration (2x) + Sync (8 symbols)</dd>

          <dt>Protocol Version</dt>
          <dd>2.0 (Compact)</dd>
        </dl>
      </section>

      <section class="help-section version">
        <h3>{t.help.versionInfo}</h3>
        <dl class="spec-list">
          <dt>Version</dt>
          <dd>{BUILD_VERSION}</dd>

          <dt>Build Time</dt>
          <dd>{formatBuildTime()}</dd>

          <dt>Audio Mode</dt>
          <dd>{mode === 'phone' ? 'Phone (600-3050 Hz)' : 'Wideband (1800-5700 Hz)'}</dd>

          <dt>FEC Mode</dt>
          <dd>{fecMode === 'normal' ? 'Normal (16 parity bytes)' : 'Robust (32 parity bytes)'}</dd>

          <dt>Source Code</dt>
          <dd><a href="https://github.com/shayanb/nedagram" target="_blank" rel="noopener noreferrer">github.com/shayanb/nedagram</a></dd>
        </dl>
      </section>
    </div>
  );
}
