import { defineConfig, devices } from '@playwright/test';

const BASE_URL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e/specs',
  snapshotPathTemplate: '{testDir}/{testFilePath}-snapshots/{arg}-{projectName}-{platform}{ext}',
  retries: 0,
  ...(process.env.CI ? { workers: 1 } : {}),
  timeout: 30_000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'browser-host-smoke',
      testMatch: 'browser-host.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1
      }
    },
    {
      name: 'webgl2-smoke',
      testMatch: 'webgl2.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1
      }
    },
    {
      name: 'webgpu-render',
      testMatch: 'webgpu-render.spec.ts',
      use: {
        ...devices['Desktop Chrome'],
        ...(process.platform === 'darwin' ? { channel: 'chrome' } : {}),
        // Linux CI supplies Xvfb, so use Chromium's headed compositor for WebGPU presentation.
        ...(process.env.CI && process.platform === 'linux' ? { headless: false } : {}),
        deviceScaleFactor: 1,
        launchOptions: {
          args: ['--enable-unsafe-webgpu']
        }
      }
    }
  ],
  webServer: {
    command:
      'pnpm exec vite build --config e2e/vite.config.ts && pnpm exec vite preview --config e2e/vite.config.ts',
    url: BASE_URL
  }
});
