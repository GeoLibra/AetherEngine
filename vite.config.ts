import { resolve } from 'node:path';
import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: resolve(__dirname, 'src/index.ts'),
      name: 'AetherEngine',
      fileName: 'aether-engine',
      formats: ['es']
    },
    sourcemap: true,
    target: 'es2022'
  },
  test: {
    environment: 'node',
    globals: true,
    passWithNoTests: true
  }
});
