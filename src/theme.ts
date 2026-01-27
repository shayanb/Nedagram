import { signal, computed } from '@preact/signals';

export type ThemeMode = 'system' | 'light' | 'dark';

const STORAGE_KEY = 'nedagram-theme';

// Load saved preference or default to system
function loadTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === 'light' || saved === 'dark') return saved;
  return 'system';
}

export const themeMode = signal<ThemeMode>(loadTheme());

// Computed: what theme is actually being displayed
export const effectiveTheme = computed(() => {
  if (themeMode.value !== 'system') return themeMode.value;
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
});

export function setTheme(mode: ThemeMode) {
  themeMode.value = mode;
  if (mode === 'system') {
    localStorage.removeItem(STORAGE_KEY);
  } else {
    localStorage.setItem(STORAGE_KEY, mode);
  }
  applyTheme();
}

export function toggleTheme() {
  // Cycle: current effective -> opposite
  const current = effectiveTheme.value;
  setTheme(current === 'dark' ? 'light' : 'dark');
}

export function applyTheme() {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;

  if (themeMode.value === 'system') {
    root.removeAttribute('data-theme');
  } else {
    root.setAttribute('data-theme', themeMode.value);
  }
}

// Initialize on load
if (typeof window !== 'undefined') {
  applyTheme();

  // Listen for system theme changes when in system mode
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (themeMode.value === 'system') {
      // Force re-render by touching the signal
      themeMode.value = 'system';
    }
  });
}
