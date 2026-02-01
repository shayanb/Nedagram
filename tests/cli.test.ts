import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync, spawnSync, spawn, ChildProcess } from 'child_process';
import { existsSync, unlinkSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import http from 'http';
import { join } from 'path';
import { tmpdir } from 'os';

// Build CLI before tests
beforeAll(() => {
  console.log('Building CLI...');
  execSync('npm run build:cli', { stdio: 'inherit' });
});

// Test directory for temporary files
let testDir: string;

beforeAll(() => {
  testDir = mkdtempSync(join(tmpdir(), 'nedagram-cli-test-'));
});

afterAll(() => {
  if (testDir && existsSync(testDir)) {
    rmSync(testDir, { recursive: true, force: true });
  }
});

const cli = (args: string[]) => {
  const result = spawnSync('node', ['dist-cli/nedagram-cli/index.cjs', ...args], {
    encoding: 'utf-8',
    timeout: 60000,
  });
  return {
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    status: result.status,
  };
};

describe('CLI', () => {
  describe('Help and Version', () => {
    it('should show help with --help', () => {
      const result = cli(['--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Encode and decode text as audio signals');
      expect(result.stdout).toContain('encode');
      expect(result.stdout).toContain('decode');
    });

    it('should show version with --version', () => {
      const result = cli(['--version']);
      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/\d+\.\d+\.\d+/);
    });

    it('should show encode help with encode --help', () => {
      const result = cli(['encode', '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Encode text into a WAV audio file');
      expect(result.stdout).toContain('--encrypt');
      expect(result.stdout).toContain('--password');
      expect(result.stdout).toContain('--mode');
      expect(result.stdout).toContain('Encryption');
    });

    it('should show decode help with decode --help', () => {
      const result = cli(['decode', '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Decode a WAV audio file back to text');
      expect(result.stdout).toContain('--password');
      expect(result.stdout).toContain('Decryption');
    });
  });

  describe('Encode', () => {
    it('should encode text to WAV file', () => {
      const output = join(testDir, 'test-encode.wav');
      const result = cli(['encode', 'Hello CLI', '-o', output, '-q']);

      expect(result.status).toBe(0);
      expect(existsSync(output)).toBe(true);
      expect(result.stderr).toContain('Message: 9 bytes');
      expect(result.stderr).toContain('SHA-256:');
    });

    it('should encode from file input', () => {
      const input = join(testDir, 'input.txt');
      const output = join(testDir, 'from-file.wav');
      writeFileSync(input, 'Content from file');

      const result = cli(['encode', '-f', input, '-o', output, '-q']);

      expect(result.status).toBe(0);
      expect(existsSync(output)).toBe(true);
      expect(result.stderr).toContain('Message: 17 bytes');
    });

    it('should fail when encrypt without password', () => {
      const output = join(testDir, 'encrypt-fail.wav');
      const result = cli(['encode', 'Test', '-o', output, '-e']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Password required');
    });

    it('should encode with phone mode', () => {
      const output = join(testDir, 'phone-mode.wav');
      const result = cli(['encode', 'Phone mode test', '-o', output, '-m', 'phone', '-q']);

      expect(result.status).toBe(0);
      expect(existsSync(output)).toBe(true);
    });

    it('should encode with wideband mode', () => {
      const output = join(testDir, 'wideband-mode.wav');
      const result = cli(['encode', 'Wideband test', '-o', output, '-m', 'wideband', '-q']);

      expect(result.status).toBe(0);
      expect(existsSync(output)).toBe(true);
    });
  });

  describe('Decode', () => {
    it('should decode WAV file back to text', () => {
      const wavFile = join(testDir, 'decode-test.wav');
      const message = 'Decode this message';

      // First encode
      cli(['encode', message, '-o', wavFile, '-q']);

      // Then decode
      const result = cli(['decode', wavFile, '-q']);

      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(message);
      expect(result.stderr).toContain(`Message: ${message.length} bytes`);
    });

    it('should decode to output file', () => {
      const wavFile = join(testDir, 'decode-to-file.wav');
      const outputFile = join(testDir, 'decoded.txt');
      const message = 'Save to file';

      cli(['encode', message, '-o', wavFile, '-q']);
      const result = cli(['decode', wavFile, '-o', outputFile, '-q']);

      expect(result.status).toBe(0);
      expect(existsSync(outputFile)).toBe(true);
      expect(readFileSync(outputFile, 'utf-8')).toBe(message);
    });

    it('should fail with non-existent file', () => {
      const result = cli(['decode', '/nonexistent/file.wav']);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Error');
    });
  });

  describe('Encryption Roundtrip', () => {
    it('should encode and decode encrypted message', () => {
      const wavFile = join(testDir, 'encrypted.wav');
      const message = 'Secret encrypted message';
      const password = 'testpassword123';

      // Encode with encryption
      const encodeResult = cli(['encode', message, '-o', wavFile, '-e', '-p', password, '-q']);
      expect(encodeResult.status).toBe(0);

      // Decode with password
      const decodeResult = cli(['decode', wavFile, '-p', password, '-q']);
      expect(decodeResult.status).toBe(0);
      expect(decodeResult.stdout.trim()).toBe(message);
    });

    it('should fail decode with wrong password', () => {
      const wavFile = join(testDir, 'encrypted-wrong.wav');
      const message = 'Secret message';

      cli(['encode', message, '-o', wavFile, '-e', '-p', 'correct', '-q']);
      const result = cli(['decode', wavFile, '-p', 'wrong', '-q']);

      // Should fail or return empty/garbled content
      expect(result.stdout.trim()).not.toBe(message);
    });

    it('should fail decode without password for encrypted file', () => {
      const wavFile = join(testDir, 'encrypted-no-pass.wav');
      cli(['encode', 'Secret', '-o', wavFile, '-e', '-p', 'secret123', '-q']);

      const result = cli(['decode', wavFile, '-q']);

      // Should return empty or fail
      expect(result.stdout.trim()).not.toBe('Secret');
    });
  });

  describe('Checksum Verification', () => {
    it('should produce matching checksums for encode and decode', () => {
      const wavFile = join(testDir, 'checksum-test.wav');
      const message = 'Checksum verification test';

      const encodeResult = cli(['encode', message, '-o', wavFile, '-q']);
      const encodeChecksum = encodeResult.stderr.match(/SHA-256: ([a-f0-9]+)/)?.[1];

      const decodeResult = cli(['decode', wavFile, '-q']);
      const decodeChecksum = decodeResult.stderr.match(/SHA-256: ([a-f0-9]+)/)?.[1];

      expect(encodeChecksum).toBeDefined();
      expect(decodeChecksum).toBeDefined();
      expect(encodeChecksum).toBe(decodeChecksum);
    });
  });

  describe('Mode Roundtrip', () => {
    it('should roundtrip with phone mode', () => {
      const wavFile = join(testDir, 'phone-roundtrip.wav');
      const message = 'Phone mode roundtrip';

      cli(['encode', message, '-o', wavFile, '-m', 'phone', '-q']);
      const result = cli(['decode', wavFile, '-q']);

      expect(result.stdout.trim()).toBe(message);
    });

    it('should roundtrip with wideband mode', () => {
      const wavFile = join(testDir, 'wideband-roundtrip.wav');
      const message = 'Wideband mode roundtrip';

      cli(['encode', message, '-o', wavFile, '-m', 'wideband', '-q']);
      const result = cli(['decode', wavFile, '-q']);

      expect(result.stdout.trim()).toBe(message);
    });
  });

  describe('Serve Command', () => {
    it('should show serve help with serve --help', () => {
      const result = cli(['serve', '--help']);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain('Start a local web server');
      expect(result.stdout).toContain('--port');
      expect(result.stdout).toContain('--quiet');
    });

    it('should start server and serve index.html', async () => {
      // Start server in background
      const serverProcess = spawn('node', ['dist-cli/nedagram-cli/index.cjs', 'serve', '-q'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let port = 8000;

      try {
        // Wait for server to start and get the port
        const portPromise = new Promise<number>((resolve, reject) => {
          let output = '';
          serverProcess.stdout?.on('data', (data) => {
            output += data.toString();
            const match = output.match(/http:\/\/localhost:(\d+)/);
            if (match) {
              resolve(parseInt(match[1], 10));
            }
          });
          serverProcess.stderr?.on('data', (data) => {
            output += data.toString();
          });
          setTimeout(() => reject(new Error('Server start timeout')), 5000);
        });

        port = await portPromise;

        // Fetch index.html
        const response = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
          http.get(`http://localhost:${port}/`, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
              resolve({ statusCode: res.statusCode || 0, headers: res.headers, body });
            });
          }).on('error', reject);
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('<!DOCTYPE html>');
        expect(response.body).toContain('Nedagram');

      } finally {
        // Kill the server process
        serverProcess.kill('SIGTERM');
      }
    });

    it('should serve manifest.json with correct content-type', async () => {
      const serverProcess = spawn('node', ['dist-cli/nedagram-cli/index.cjs', 'serve', '-q'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let port = 8000;

      try {
        const portPromise = new Promise<number>((resolve, reject) => {
          let output = '';
          serverProcess.stdout?.on('data', (data) => {
            output += data.toString();
            const match = output.match(/http:\/\/localhost:(\d+)/);
            if (match) resolve(parseInt(match[1], 10));
          });
          setTimeout(() => reject(new Error('Server start timeout')), 5000);
        });

        port = await portPromise;

        // Fetch manifest.json
        const response = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
          http.get(`http://localhost:${port}/manifest.json`, (res) => {
            res.on('data', () => {});
            res.on('end', () => {
              resolve({ statusCode: res.statusCode || 0, headers: res.headers });
            });
          }).on('error', reject);
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('application/json');

      } finally {
        serverProcess.kill('SIGTERM');
      }
    });

    it('should serve CSS assets with correct content-type', async () => {
      const serverProcess = spawn('node', ['dist-cli/nedagram-cli/index.cjs', 'serve', '-q'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let port = 8000;

      try {
        const portPromise = new Promise<number>((resolve, reject) => {
          let output = '';
          serverProcess.stdout?.on('data', (data) => {
            output += data.toString();
            const match = output.match(/http:\/\/localhost:(\d+)/);
            if (match) resolve(parseInt(match[1], 10));
          });
          setTimeout(() => reject(new Error('Server start timeout')), 5000);
        });

        port = await portPromise;

        // First get index.html to find the CSS filename
        const indexResponse = await new Promise<string>((resolve, reject) => {
          http.get(`http://localhost:${port}/`, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => resolve(body));
          }).on('error', reject);
        });

        // Extract CSS filename from index.html
        const cssMatch = indexResponse.match(/href="\/?(assets\/[^"]+\.css)"/);
        expect(cssMatch).toBeTruthy();
        const cssPath = cssMatch![1];

        // Fetch CSS file
        const response = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
          http.get(`http://localhost:${port}/${cssPath}`, (res) => {
            res.on('data', () => {});
            res.on('end', () => {
              resolve({ statusCode: res.statusCode || 0, headers: res.headers });
            });
          }).on('error', reject);
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/css');

      } finally {
        serverProcess.kill('SIGTERM');
      }
    });

    it('should return index.html for SPA routes (fallback)', async () => {
      const serverProcess = spawn('node', ['dist-cli/nedagram-cli/index.cjs', 'serve', '-q'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let port = 8000;

      try {
        const portPromise = new Promise<number>((resolve, reject) => {
          let output = '';
          serverProcess.stdout?.on('data', (data) => {
            output += data.toString();
            const match = output.match(/http:\/\/localhost:(\d+)/);
            if (match) resolve(parseInt(match[1], 10));
          });
          setTimeout(() => reject(new Error('Server start timeout')), 5000);
        });

        port = await portPromise;

        // Fetch a SPA route
        const response = await new Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
          http.get(`http://localhost:${port}/receive`, (res) => {
            let body = '';
            res.on('data', chunk => { body += chunk; });
            res.on('end', () => {
              resolve({ statusCode: res.statusCode || 0, headers: res.headers, body });
            });
          }).on('error', reject);
        });

        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/html');
        expect(response.body).toContain('<!DOCTYPE html>');

      } finally {
        serverProcess.kill('SIGTERM');
      }
    });

    it('should fall back to next port if default is busy', async () => {
      // Start first server on port 8000
      const server1 = spawn('node', ['dist-cli/nedagram-cli/index.cjs', 'serve', '-q', '-p', '8000'], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let port1 = 8000;
      let port2 = 8001;

      try {
        // Wait for first server
        const port1Promise = new Promise<number>((resolve, reject) => {
          let output = '';
          server1.stdout?.on('data', (data) => {
            output += data.toString();
            const match = output.match(/http:\/\/localhost:(\d+)/);
            if (match) resolve(parseInt(match[1], 10));
          });
          setTimeout(() => reject(new Error('Server 1 start timeout')), 5000);
        });

        port1 = await port1Promise;

        // Start second server (should use next available port)
        const server2 = spawn('node', ['dist-cli/nedagram-cli/index.cjs', 'serve', '-q', '-p', String(port1)], {
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        try {
          const port2Promise = new Promise<number>((resolve, reject) => {
            let output = '';
            server2.stdout?.on('data', (data) => {
              output += data.toString();
              const match = output.match(/http:\/\/localhost:(\d+)/);
              if (match) resolve(parseInt(match[1], 10));
            });
            setTimeout(() => reject(new Error('Server 2 start timeout')), 5000);
          });

          port2 = await port2Promise;
          expect(port2).toBe(port1 + 1);

        } finally {
          server2.kill('SIGTERM');
        }
      } finally {
        server1.kill('SIGTERM');
      }
    });
  });
});
