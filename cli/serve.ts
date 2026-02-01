/**
 * Nedagram CLI - Serve web interface
 */

import { createServer, IncomingMessage, ServerResponse } from 'http';
import { WEB_ASSETS, getMimeType } from './web-assets.js';

const DEFAULT_PORT = 8000;
const MAX_PORT_ATTEMPTS = 10;

interface ServeOptions {
  port?: string;
  quiet?: boolean;
}

/**
 * Try to start server on a port, returns the server if successful
 */
function tryListen(port: number): Promise<ReturnType<typeof createServer> | null> {
  return new Promise((resolve) => {
    const server = createServer(handleRequest);

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve(null);
      } else {
        throw err;
      }
    });

    server.listen(port, () => {
      resolve(server);
    });
  });
}

/**
 * Handle incoming HTTP requests
 */
function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  let path = req.url || '/';

  // Remove query string
  path = path.split('?')[0];

  // Normalize path
  if (path === '/') {
    path = '/index.html';
  }

  // Remove leading slash for asset lookup
  const assetPath = path.startsWith('/') ? path.slice(1) : path;

  // Look up asset
  const base64Content = WEB_ASSETS[assetPath];

  if (base64Content) {
    const mimeType = getMimeType(assetPath);
    const content = Buffer.from(base64Content, 'base64');

    res.writeHead(200, {
      'Content-Type': mimeType,
      'Content-Length': content.length,
      'Cache-Control': 'no-cache',
    });
    res.end(content);
  } else {
    // 404 - return index.html for SPA routing
    const indexContent = WEB_ASSETS['index.html'];
    if (indexContent) {
      const content = Buffer.from(indexContent, 'base64');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': content.length,
        'Cache-Control': 'no-cache',
      });
      res.end(content);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  }
}

/**
 * Serve command handler
 */
export async function serveCommand(options: ServeOptions): Promise<void> {
  // Check if assets are embedded
  if (Object.keys(WEB_ASSETS).length === 0) {
    console.error('Error: Web assets not embedded. Please rebuild the CLI with web assets.');
    process.exit(1);
  }

  const startPort = options.port ? parseInt(options.port, 10) : DEFAULT_PORT;

  if (isNaN(startPort) || startPort < 1 || startPort > 65535) {
    console.error('Error: Invalid port number');
    process.exit(1);
  }

  // Try ports starting from startPort
  let server: ReturnType<typeof createServer> | null = null;
  let port = startPort;

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    server = await tryListen(port);
    if (server) break;

    if (!options.quiet) {
      console.log(`Port ${port} is busy, trying ${port + 1}...`);
    }
    port++;
  }

  if (!server) {
    console.error(`Error: Could not find an available port (tried ${startPort}-${port - 1})`);
    process.exit(1);
  }

  const url = `http://localhost:${port}`;

  if (!options.quiet) {
    console.log(`
Nedagram web interface is running at:

  ${url}

Open this URL in your browser to use Nedagram.
Press Ctrl+C to stop the server.
`);
  } else {
    console.log(url);
  }

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    if (!options.quiet) {
      console.log('\nShutting down...');
    }
    server!.close();
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    server!.close();
    process.exit(0);
  });
}
