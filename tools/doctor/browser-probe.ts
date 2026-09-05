import { chromium, type Browser, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { createServer, type ViteDevServer } from 'vite';

import { browserGraphicsArgs } from '../../e2e/browser-launch-options';
import type { E2EState } from '../../e2e/harness/types';
import { createBrowserBackendResult } from './browser-result';
import type { DoctorBackend, DoctorBackendResult } from './types';

const HARNESS_CONFIG = fileURLToPath(new URL('../../e2e/vite.config.ts', import.meta.url));

/** Creates a real-browser probe backed by Aether's rendered E2E scene corpus. */
export async function createBrowserDoctorProbe(): Promise<{
  readonly probe: (backend: DoctorBackend) => Promise<DoctorBackendResult>;
  readonly close: () => Promise<void>;
}> {
  const server = await createServer({
    configFile: HARNESS_CONFIG,
    logLevel: 'error',
    server: { host: '127.0.0.1', port: 0 }
  });
  await listenDoctorServer(server);
  const serverUrl = resolveDoctorServerUrl(server);

  return Object.freeze({
    probe: (backend: DoctorBackend) => runBrowserProbe(serverUrl, backend),
    close: async () => server.close()
  });
}

/** Returns the loopback URL selected by Vite after binding an available ephemeral port. */
export function resolveDoctorServerUrl(server: Pick<ViteDevServer, 'resolvedUrls'>): string {
  const url = server.resolvedUrls?.local[0];
  if (url === undefined) throw new Error('Aether Doctor harness did not publish a local URL.');
  return url.replace(/\/$/, '');
}

/** True only after the browser harness bridge exists and reaches a terminal boot state. */
export function browserHarnessHasFinished(
  bridge?: Pick<Window['__AETHER_E2E__'], 'state'>
): boolean {
  const current = bridge ?? (typeof window === 'undefined' ? undefined : window.__AETHER_E2E__);
  return current !== undefined && current.state().status !== 'booting';
}

/** Starts the harness server and guarantees cleanup when binding the port fails. */
export async function listenDoctorServer(
  server: Pick<ViteDevServer, 'listen' | 'close'>
): Promise<void> {
  try {
    await server.listen();
  } catch (cause) {
    await server.close();
    throw cause;
  }
}

async function runBrowserProbe(
  serverUrl: string,
  backend: DoctorBackend
): Promise<DoctorBackendResult> {
  let browser: Browser | undefined;
  let page: Page | undefined;
  try {
    browser = await chromium.launch({
      ...(process.platform === 'darwin' ? { channel: 'chrome' as const } : {}),
      args: browserGraphicsArgs(backend, process.platform)
    });
    page = await browser.newPage({ deviceScaleFactor: 1 });
    await page.goto(`${serverUrl}/?scenario=${backend}`);
    await page.waitForFunction(browserHarnessHasFinished, undefined, { timeout: 15_000 });
    const state = await page.evaluate(() => window.__AETHER_E2E__.state());
    if (state.status !== 'ready')
      return createBrowserBackendResult(backend, state, new Uint8Array());

    const screenshot = await page.locator('canvas').screenshot({ type: 'png' });
    const pixels = await decodePngInBrowser(page, screenshot.toString('base64'));
    const result = createBrowserBackendResult(backend, state as E2EState, pixels);
    await page.evaluate(() => window.__AETHER_E2E__.teardown());
    const terminal = await page.evaluate(() => window.__AETHER_E2E__.state());
    if (terminal.status !== 'destroyed') {
      throw new Error(`Harness teardown ended in ${terminal.status} state.`);
    }
    return Object.freeze({
      ...result,
      stages: Object.freeze([
        ...result.stages,
        Object.freeze({ name: 'teardown', status: 'passed' as const })
      ])
    });
  } finally {
    if (page !== undefined) {
      await page.evaluate(() => window.__AETHER_E2E__?.teardown()).catch(() => undefined);
    }
    await browser?.close();
  }
}

async function decodePngInBrowser(page: Page, base64: string): Promise<Uint8Array> {
  const bytes = await page.evaluate(async (encoded) => {
    const image = new Image();
    image.src = `data:image/png;base64,${encoded}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('Doctor could not create its pixel readback canvas.');
    context.drawImage(image, 0, 0);
    return [...context.getImageData(0, 0, canvas.width, canvas.height).data];
  }, base64);
  return new Uint8Array(bytes);
}
