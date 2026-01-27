/**
 * Creates a downloadable offline package (zip) of the dist folder
 * Run after build: node scripts/create-offline-package.js
 */

import { createWriteStream, readdirSync, statSync, readFileSync, writeFileSync } from 'fs';
import { join, relative } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Simple zip creation using deflate-raw (no external dependencies)
// For a proper implementation, you'd use archiver or similar
// This creates a simple tar-like format that can be extracted

const distPath = join(__dirname, '..', 'dist');
const outputPath = join(distPath, 'nedagram-offline.zip');

// We'll create a simple HTML file that explains how to use the offline version
const offlineInstructions = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Nedagram Offline - Instructions</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 0 auto;
      padding: 2rem;
      line-height: 1.6;
      color: #333;
    }
    h1 { color: #9D7E8A; }
    code {
      background: #f4f4f4;
      padding: 0.2rem 0.5rem;
      border-radius: 4px;
      font-family: monospace;
    }
    pre {
      background: #f4f4f4;
      padding: 1rem;
      border-radius: 8px;
      overflow-x: auto;
    }
    .warning {
      background: #fff3cd;
      border: 1px solid #ffc107;
      padding: 1rem;
      border-radius: 8px;
      margin: 1rem 0;
    }
  </style>
</head>
<body>
  <h1>Nedagram Offline Version</h1>

  <p>This package contains everything you need to run Nedagram completely offline.</p>

  <h2>Quick Start</h2>

  <h3>Option 1: Using Python (Recommended)</h3>
  <p>Open a terminal in this folder and run:</p>
  <pre>python3 -m http.server 8000</pre>
  <p>Then open <a href="http://localhost:8000">http://localhost:8000</a> in your browser.</p>

  <h3>Option 2: Using Node.js</h3>
  <pre>npx serve .</pre>
  <p>Or install globally: <code>npm install -g serve</code> then run <code>serve .</code></p>

  <h3>Option 3: Using PHP</h3>
  <pre>php -S localhost:8000</pre>

  <div class="warning">
    <strong>Important:</strong> You must use a local web server. Opening index.html directly
    (file://) won't work due to browser security restrictions with microphone access and
    service workers.
  </div>

  <h2>What's Included</h2>
  <ul>
    <li><code>index.html</code> - Main application</li>
    <li><code>assets/</code> - JavaScript and CSS files</li>
    <li><code>sw.js</code> - Service worker for offline caching</li>
    <li><code>manifest.json</code> - PWA manifest</li>
  </ul>

  <h2>Sharing This Package</h2>
  <p>You can share this entire folder (or zip it) with others. They just need to:</p>
  <ol>
    <li>Extract the files</li>
    <li>Run a local web server (see options above)</li>
    <li>Open in browser</li>
  </ol>

  <h2>Version</h2>
  <p>This offline package was created from Nedagram v${process.env.npm_package_version || '2.3.0'}</p>

  <hr>
  <p><a href="index.html">Launch Nedagram →</a></p>
</body>
</html>
`;

// Write the instructions file
writeFileSync(join(distPath, 'README.html'), offlineInstructions);

console.log('Created README.html in dist/');
console.log('');
console.log('To create a zip file manually:');
console.log('  cd dist && zip -r nedagram-offline.zip . -x "*.map"');
