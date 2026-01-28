#!/usr/bin/env node
/**
 * Build script for Nedagram CLI
 * Uses esbuild to bundle the CLI with Node.js compatibility
 */

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, chmodSync, rmSync, mkdirSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// Clean and recreate output directory
rmSync('dist-cli/nedagram-cli', { recursive: true, force: true });
mkdirSync('dist-cli/nedagram-cli', { recursive: true });

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
  // Bundle all dependencies for standalone distribution
  minify: false,
  sourcemap: false,
});

// Add shebang to the output file
const outputPath = 'dist-cli/nedagram-cli/index.cjs';
const content = readFileSync(outputPath, 'utf-8');
writeFileSync(outputPath, '#!/usr/bin/env node\n' + content);

// Make executable
chmodSync(outputPath, 0o755);

console.log('CLI built successfully: dist-cli/nedagram-cli/index.cjs');
