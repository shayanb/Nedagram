import { useState, useCallback } from 'preact/hooks';
import { useI18n } from '../i18n';
import { BUILD_VERSION, formatBuildTime } from '../utils/version';
import { getAudioMode } from '../utils/constants';
import './Help.css';

// Command block with copy button
function CommandBlock({ command, label }: { command: string; label: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Copy failed:', err);
    }
  }, [command]);

  return (
    <div class="command-block">
      <span class="command-label">{label}</span>
      <div class="command-row">
        <code class="command-text">{command}</code>
        <button
          class={`copy-btn ${copied ? 'copied' : ''}`}
          onClick={handleCopy}
          title={copied ? 'Copied!' : 'Copy to clipboard'}
        >
          {copied ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}

export function Help() {
  const { t } = useI18n();
  const mode = getAudioMode();

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

        <div class="server-commands">
          <p class="commands-title">{t.help.serverCommands}</p>
          <CommandBlock label="Python" command="python3 -m http.server 8000 --bind 127.0.0.1" />
          <CommandBlock label="Node.js" command="npx serve . -l 8000" />
        </div>

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
      <section class="help-section cli">
        <h4>Command Line Interface (CLI)</h4>
        <p>The offline package includes a CLI for encoding/decoding WAV files without a browser. Requires Node.js 18+.</p>

        <div class="server-commands">
          <p class="commands-title">CLI Usage (from extracted folder)</p>
          <CommandBlock label="Encode" command='node cli/index.cjs encode "Hello World" -o message.wav' />
          <CommandBlock label="Decode" command="node cli/index.cjs decode message.wav" />
          <CommandBlock label="Help" command='node cli/index.cjs --help' />
        </div>

        <p class="mode-note">
          Or install globally: <code>npm install -g @nedagram/nedagram</code> then use <code>nedagram</code> command directly.
          Use <code>--json</code> for machine-readable output.
        </p>
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

      </section>

      <section class="help-section specs">
        <h3>{t.help.technicalSpecs}</h3>

        <h4>Phone Mode (Optimized for GSM/Phone Calls)</h4>
        <dl class="spec-list">
          <dt>Modulation</dt>
          <dd>4-MFSK (2 bits per symbol)</dd>

          <dt>Tone Frequencies</dt>
          <dd>800, 1300, 1800, 2300 Hz</dd>

          <dt>Tone Spacing</dt>
          <dd>500 Hz (wide for codec tolerance)</dd>

          <dt>Symbol Duration</dt>
          <dd>50ms + 12ms guard</dd>

          <dt>Effective Bitrate</dt>
          <dd>~20-25 bps</dd>

          <dt>Burst Protection</dt>
          <dd>Block interleaving enabled</dd>
        </dl>

        <h4>Wideband Mode (HD Voice / Direct)</h4>
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
          <dt>Parity Bytes</dt>
          <dd>16 bytes per frame</dd>

          <dt>Error Correction</dt>
          <dd>Up to 8 byte errors per frame</dd>
        </dl>

        <h4>Synchronization (Phone Mode)</h4>
        <dl class="spec-list">
          <dt>Warmup Tone</dt>
          <dd>200ms steady tone for audio path wake-up</dd>

          <dt>Chirp Sweep</dt>
          <dd>800ms up-down frequency sweep (600-2600 Hz)</dd>

          <dt>Detection Method</dt>
          <dd>Matched filter cross-correlation (robust to noise)</dd>

          <dt>Calibration</dt>
          <dd>4 tones repeated 2x for level calibration</dd>

          <dt>Sync Pattern</dt>
          <dd>8-symbol alternating pattern</dd>
        </dl>

        <h4>Synchronization (Wideband Mode)</h4>
        <dl class="spec-list">
          <dt>Warmup Tone</dt>
          <dd>400ms steady tone for AGC settling</dd>

          <dt>Chirp Sweep</dt>
          <dd>1200ms up-down frequency sweep (1000-4000 Hz)</dd>

          <dt>Detection Method</dt>
          <dd>Matched filter cross-correlation (robust to noise)</dd>

          <dt>Calibration</dt>
          <dd>4 tones repeated 3x for level calibration</dd>

          <dt>Sync Pattern</dt>
          <dd>8-symbol alternating pattern</dd>
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
          <dd>{mode === 'phone' ? 'Phone (800-2300 Hz, 4 tones)' : 'Wideband (1800-5700 Hz, 16 tones)'}</dd>

          <dt>Source Code</dt>
          <dd><a href="https://github.com/shayanb/nedagram" target="_blank" rel="noopener noreferrer">github.com/shayanb/nedagram</a></dd>
        </dl>
      </section>
    </div>
  );
}
