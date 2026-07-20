import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

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
    exclude: [...configDefaults.exclude, 'e2e/specs/**', '.pnpm-store/**', '.worktrees/**'],
    globals: true,
    passWithNoTests: true
  }
});
