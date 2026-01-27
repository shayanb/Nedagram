/**
 * Build version and time constants
 * These are injected at build time by Vite
 */

declare const __BUILD_TIME__: string;
declare const __BUILD_VERSION__: string;

export const BUILD_TIME = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : 'dev';
export const BUILD_VERSION = typeof __BUILD_VERSION__ !== 'undefined' ? __BUILD_VERSION__ : '0.0.0';

// Format build time for display
export function formatBuildTime(): string {
  if (BUILD_TIME === 'dev') return 'Development';
  try {
    const date = new Date(BUILD_TIME);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return BUILD_TIME;
  }
}
