import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const E2E_ROOT = fileURLToPath(new URL('./harness', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

export default defineConfig({
  root: E2E_ROOT,
  server: {
    host: '127.0.0.1',
    port: 4173,
    fs: {
      allow: [REPOSITORY_ROOT]
    }
  },
  preview: {
    host: '127.0.0.1',
    port: 4173
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true
  }
});
