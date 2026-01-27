import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import pkg from './package.json';

export default defineConfig({
  plugins: [
    preact(),
    basicSsl(), // Enables HTTPS for local development
  ],
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __BUILD_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    https: true,
    host: true, // Expose to network
  },
  build: {
    target: 'es2020',
    rollupOptions: {
      output: {
        manualChunks: {
          'reed-solomon': ['./src/lib/reed-solomon.ts'],
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
});
