/**
 * Embedded web assets for CLI serve command
 *
 * This file is a placeholder. During build, the build script
 * populates WEB_ASSETS with base64-encoded content from dist/.
 */

// Assets are injected at build time as a map of path -> base64 content
export const WEB_ASSETS: Record<string, string> = {};

// MIME type lookup
export function getMimeType(path: string): string {
  const ext = path.split('.').pop()?.toLowerCase() || '';
  const mimeTypes: Record<string, string> = {
    'html': 'text/html; charset=utf-8',
    'css': 'text/css; charset=utf-8',
    'js': 'application/javascript; charset=utf-8',
    'json': 'application/json; charset=utf-8',
    'svg': 'image/svg+xml',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'ico': 'image/x-icon',
    'woff': 'font/woff',
    'woff2': 'font/woff2',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}
