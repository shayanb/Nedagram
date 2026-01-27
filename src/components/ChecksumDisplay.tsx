import { useState } from 'preact/hooks';
import './ChecksumDisplay.css';

interface ChecksumDisplayProps {
  checksum: string;
  label: string;
  verified?: boolean;
}

export function ChecksumDisplay({ checksum, label, verified }: ChecksumDisplayProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(checksum);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const shortChecksum = checksum.slice(0, 8) + '...' + checksum.slice(-8);

  return (
    <div class={`checksum-display ${verified === true ? 'verified' : verified === false ? 'mismatch' : ''}`}>
      <span class="checksum-label">{label}</span>
      <div class="checksum-value-wrapper">
        <code class="checksum-value" title={checksum}>
          {shortChecksum}
        </code>
        <button class="checksum-copy" onClick={handleCopy} title="Copy full checksum">
          {copied ? (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
        {verified === true && (
          <svg class="checksum-status" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" stroke-width="2">
            <path d="M20 6L9 17l-5-5" />
          </svg>
        )}
        {verified === false && (
          <svg class="checksum-status" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" stroke-width="2">
            <circle cx="12" cy="12" r="10" />
            <path d="M15 9l-6 6M9 9l6 6" />
          </svg>
        )}
      </div>
    </div>
  );
}
