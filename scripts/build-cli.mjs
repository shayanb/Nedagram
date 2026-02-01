#!/usr/bin/env node
/**
 * Build script for Nedagram CLI
 * Uses esbuild to bundle the CLI with Node.js compatibility
 * Embeds web assets for the serve command
 */

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, chmodSync, rmSync, mkdirSync, readdirSync, statSync, existsSync, copyFileSync } from 'fs';
import { join, relative, resolve } from 'path';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// Clean and recreate output directory
rmSync('dist-cli/nedagram-cli', { recursive: true, force: true });
mkdirSync('dist-cli/nedagram-cli', { recursive: true });

/**
 * Recursively collect all files from a directory
 */
function collectFiles(dir, basePath = dir) {
  const files = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(fullPath, basePath));
    } else if (entry.isFile()) {
      const relativePath = relative(basePath, fullPath);
      files.push({ fullPath, relativePath });
    }
  }

  return files;
}

/**
 * Build web assets map from dist folder
 */
function buildWebAssets() {
  const distPath = './dist';

  if (!existsSync(distPath)) {
    console.error('Error: dist/ folder not found. Run "npm run build" first.');
    process.exit(1);
  }

  const assets = {};
  const files = collectFiles(distPath);

  // Files to exclude from embedding
  const excludePatterns = [
    '.DS_Store',
    'CNAME',
    '.zip',
    'cli/',  // Don't embed CLI in itself
  ];

  for (const { fullPath, relativePath } of files) {
    // Check exclusions
    const shouldExclude = excludePatterns.some(pattern =>
      relativePath.includes(pattern)
    );

    if (shouldExclude) continue;

    // Read file and encode as base64
    const content = readFileSync(fullPath);
    assets[relativePath] = content.toString('base64');
  }

  return assets;
}

// Build web assets
console.log('Collecting web assets from dist/...');
const webAssets = buildWebAssets();
console.log(`Embedded ${Object.keys(webAssets).length} files`);

// Create a modified web-assets.ts with embedded assets
const webAssetsSource = `/**
 * Embedded web assets for CLI serve command
 * Auto-generated during build - DO NOT EDIT
 */

export const WEB_ASSETS: Record<string, string> = ${JSON.stringify(webAssets, null, 2)};

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
`;

// Write temporary file with embedded assets
const tempAssetsPath = 'cli/web-assets.generated.ts';
const absoluteTempAssetsPath = resolve(tempAssetsPath);
writeFileSync(tempAssetsPath, webAssetsSource);

// Create esbuild plugin to resolve web-assets import to generated file
const webAssetsPlugin = {
  name: 'web-assets-plugin',
  setup(build) {
    build.onResolve({ filter: /\.\/web-assets\.js$/ }, () => {
      return { path: absoluteTempAssetsPath };
    });
  },
};

await esbuild.build({
  entryPoints: ['cli/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'cjs',
  outfile: 'dist-cli/nedagram-cli/index.cjs',
  banner: {
    js: `// Nedagram CLI v${pkg.version}
const { webcrypto } = require('node:crypto');
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}`,
  },
  define: {
    '__VERSION__': JSON.stringify(pkg.version),
  },
  plugins: [webAssetsPlugin],
  // Bundle all dependencies for standalone distribution
  minify: false,
  sourcemap: false,
});

// Clean up temporary file
rmSync(tempAssetsPath);

// Add shebang to the output file
const outputPath = 'dist-cli/nedagram-cli/index.cjs';
const content = readFileSync(outputPath, 'utf-8');
writeFileSync(outputPath, '#!/usr/bin/env node\n' + content);

// Make executable
chmodSync(outputPath, 0o755);

// Calculate size
const stats = statSync(outputPath);
const sizeKB = Math.round(stats.size / 1024);
console.log(`CLI built successfully: ${outputPath} (${sizeKB} KB)`);
