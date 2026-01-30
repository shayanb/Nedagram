import { useEffect, useRef, useCallback } from 'preact/hooks';
import { signal } from '@preact/signals';
import { BUILD_VERSION, BUILD_TIME } from '../utils/version';
import { getAudioMode } from '../utils/constants';
import './DebugLog.css';

// Log entry type
interface LogEntry {
  id: number;
  timestamp: number;
  level: 'log' | 'warn' | 'error';
  message: string;
  fading?: boolean;
}

// Global log store
const logs = signal<LogEntry[]>([]);
const isEnabled = signal(false);
const isExpanded = signal(false);
let logId = 0;

// Max entries to keep
const MAX_LOGS = 50;
const FADE_DELAY = 8000; // 8 seconds before fading
const FADE_DURATION = 2000; // 2 seconds fade

// Intercept console methods
const originalConsole = {
  log: console.log.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
};

function addLog(level: 'log' | 'warn' | 'error', args: unknown[]) {
  if (!isEnabled.value) return;

  const message = args.map(arg =>
    typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
  ).join(' ');

  // Only capture relevant logs (decoder, FEC, etc.)
  if (!message.includes('[Decoder]') &&
      !message.includes('[FEC]') &&
      !message.includes('[Receive]') &&
      !message.includes('[Audio]') &&
      !message.includes('[ChirpDetector]')) {
    return;
  }

  const entry: LogEntry = {
    id: ++logId,
    timestamp: Date.now(),
    level,
    message: message.replace(/^\[(.*?)\]\s*/, ''), // Remove prefix brackets
  };

  logs.value = [...logs.value.slice(-MAX_LOGS + 1), entry];

  // Auto-fade after delay (unless expanded)
  setTimeout(() => {
    if (!isExpanded.value) {
      logs.value = logs.value.map(l =>
        l.id === entry.id ? { ...l, fading: true } : l
      );
    }
  }, FADE_DELAY);

  // Remove after fade
  setTimeout(() => {
    if (!isExpanded.value) {
      logs.value = logs.value.filter(l => l.id !== entry.id);
    }
  }, FADE_DELAY + FADE_DURATION);
}

// Hook console methods
function hookConsole() {
  console.log = (...args) => {
    originalConsole.log(...args);
    addLog('log', args);
  };
  console.warn = (...args) => {
    originalConsole.warn(...args);
    addLog('warn', args);
  };
  console.error = (...args) => {
    originalConsole.error(...args);
    addLog('error', args);
  };
}

function unhookConsole() {
  console.log = originalConsole.log;
  console.warn = originalConsole.warn;
  console.error = originalConsole.error;
}

// Enable/disable logging (logs are preserved until explicitly cleared)
export function enableDebugLog(enabled: boolean) {
  isEnabled.value = enabled;
  if (enabled) {
    hookConsole();
  } else {
    unhookConsole();
    // Don't clear logs - user can review them even after stopping
  }
}

export function isDebugLogEnabled(): boolean {
  return isEnabled.value;
}

// Clear logs
export function clearDebugLogs() {
  logs.value = [];
}

// Get environment info for debug report
function getEnvironmentInfo(): Record<string, string> {
  const ua = navigator.userAgent;

  // Detect browser
  let browser = 'Unknown';
  if (ua.includes('Firefox/')) {
    browser = 'Firefox ' + (ua.match(/Firefox\/(\d+)/)?.[1] || '');
  } else if (ua.includes('Edg/')) {
    browser = 'Edge ' + (ua.match(/Edg\/(\d+)/)?.[1] || '');
  } else if (ua.includes('Chrome/')) {
    browser = 'Chrome ' + (ua.match(/Chrome\/(\d+)/)?.[1] || '');
  } else if (ua.includes('Safari/') && !ua.includes('Chrome')) {
    browser = 'Safari ' + (ua.match(/Version\/(\d+)/)?.[1] || '');
  }

  // Detect OS
  let os = 'Unknown';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Mac OS X')) os = 'macOS';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('Linux')) os = 'Linux';

  // Detect device type
  let device = 'Desktop';
  if (/iPhone|iPad|iPod|Android/i.test(ua)) {
    device = /iPad/i.test(ua) ? 'Tablet' : 'Mobile';
  }

  return { browser, os, device };
}

// Generate debug report for copying
export function generateDebugReport(): string {
  const env = getEnvironmentInfo();
  const mode = getAudioMode();

  const lines: string[] = [
    '## Nedagram Debug Report',
    '',
    '### Build Info',
    '```',
    `Version: ${BUILD_VERSION}`,
    `Build Time: ${BUILD_TIME}`,
    `Audio Mode: ${mode}`,
    '```',
    '',
    '### Environment',
    '```',
    `Browser: ${env.browser}`,
    `OS: ${env.os}`,
    `Device: ${env.device}`,
    `Screen: ${window.screen.width}x${window.screen.height}`,
    `Viewport: ${window.innerWidth}x${window.innerHeight}`,
    '```',
  ];

  if (logs.value.length > 0) {
    lines.push('', '### Session Log', '```');
    logs.value.forEach(log => {
      const time = new Date(log.timestamp).toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      const prefix = log.level === 'error' ? '[ERROR] ' : log.level === 'warn' ? '[WARN] ' : '';
      lines.push(`${time} ${prefix}${log.message}`);
    });
    lines.push('```');
  }

  lines.push('', `Generated: ${new Date().toISOString()}`);

  return lines.join('\n');
}

// Copy state
const copyState = signal<'idle' | 'copied'>('idle');

// Component
export function DebugLog() {
  const scrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll when new logs arrive
  useEffect(() => {
    if (scrollRef.current && isExpanded.value) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs.value.length]);

  const handleToggle = useCallback(() => {
    // If not enabled, enable it and expand
    if (!isEnabled.value) {
      enableDebugLog(true);
      isExpanded.value = true;
    } else {
      // If enabled, just toggle expanded state (keep logging in background)
      isExpanded.value = !isExpanded.value;
    }
    // Clear fading state when expanding
    if (isExpanded.value) {
      logs.value = logs.value.map(l => ({ ...l, fading: false }));
    }
  }, []);

  const handleClear = useCallback(() => {
    clearDebugLogs();
  }, []);

  const handleCopy = useCallback(async () => {
    const report = generateDebugReport();
    try {
      await navigator.clipboard.writeText(report);
      copyState.value = 'copied';
      setTimeout(() => {
        copyState.value = 'idle';
      }, 2000);
    } catch (err) {
      console.error('Failed to copy debug report:', err);
    }
  }, []);

  const handleStop = useCallback(() => {
    enableDebugLog(false);
    isExpanded.value = false;
  }, []);

  const visibleLogs = isExpanded.value ? logs.value : logs.value.slice(-5);

  return (
    <div class={`debug-log ${isExpanded.value ? 'expanded' : ''} ${isEnabled.value ? 'enabled' : ''}`}>
      {/* Toggle button - always visible */}
      <button
        class={`debug-toggle ${isEnabled.value ? 'active' : ''}`}
        onClick={handleToggle}
        title={isEnabled.value ? (isExpanded.value ? 'Collapse logs' : 'Expand logs') : 'Enable debug logs'}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="16" y1="13" x2="8" y2="13" />
          <line x1="16" y1="17" x2="8" y2="17" />
        </svg>
        {isEnabled.value && <span>{logs.value.length}</span>}
        {isEnabled.value && (
          <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            class={`chevron ${isExpanded.value ? 'up' : ''}`}
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        )}
      </button>

      {/* Log entries - only when enabled */}
      {isEnabled.value && (
        <div class="debug-entries" ref={scrollRef}>
          {visibleLogs.map((log) => (
            <div
              key={log.id}
              class={`debug-entry ${log.level} ${log.fading ? 'fading' : ''}`}
            >
              <span class="debug-time">
                {new Date(log.timestamp).toLocaleTimeString('en-US', {
                  hour12: false,
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit',
                })}
              </span>
              <span class="debug-message">{log.message}</span>
            </div>
          ))}
          {visibleLogs.length === 0 && isExpanded.value && (
            <div class="debug-empty">No logs yet...</div>
          )}
        </div>
      )}

      {/* Action buttons (only when expanded) */}
      {isEnabled.value && isExpanded.value && (
        <div class="debug-actions">
          <button class="debug-btn" onClick={handleClear}>
            Clear
          </button>
          <button class="debug-btn debug-copy" onClick={handleCopy}>
            {copyState.value === 'copied' ? 'Copied!' : 'Copy'}
          </button>
          <button class="debug-btn debug-stop" onClick={handleStop}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
