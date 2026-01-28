import { useState, useEffect, useRef, useCallback } from 'preact/hooks';
import { signal } from '@preact/signals';
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
          {logs.value.length > 0 && (
            <button class="debug-clear" onClick={handleClear}>
              Clear
            </button>
          )}
          <button class="debug-stop" onClick={handleStop}>
            Stop
          </button>
        </div>
      )}
    </div>
  );
}
