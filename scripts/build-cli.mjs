#!/usr/bin/env node
/**
 * Build script for Nedagram CLI
 * Uses esbuild to bundle the CLI with Node.js compatibility
 */

import * as esbuild from 'esbuild';
import { readFileSync, writeFileSync, chmodSync } from 'fs';

const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));

// Node.js polyfill for webcrypto
const cryptoPolyfill = `import { webcrypto } from 'node:crypto';
if (typeof globalThis.crypto === 'undefined') {
  globalThis.crypto = webcrypto;
}
// Nedagram CLI v${pkg.version}`;

await esbuild.build({
  entryPoints: ['cli/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node18',
  format: 'esm',
  outfile: 'dist-cli/cli/index.js',
  banner: {
    js: cryptoPolyfill,
  },
  define: {
    '__VERSION__': JSON.stringify(pkg.version),
  },
  packages: 'external', // Don't bundle node_modules
  minify: false,
  sourcemap: false,
});

// Add shebang to the output file
const outputPath = 'dist-cli/cli/index.js';
const content = readFileSync(outputPath, 'utf-8');
writeFileSync(outputPath, '#!/usr/bin/env node\n' + content);

// Make executable
chmodSync(outputPath, 0o755);

console.log('CLI built successfully: dist-cli/cli/index.js');
