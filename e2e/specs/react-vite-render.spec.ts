import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __AETHER_EXAMPLE__?: {
      state(): Record<string, unknown>;
      resize(width: number, height: number): void;
      setRotation(angleRadians: number): void;
    };
  }
}

test('renders the public React example and survives surface suspension', async ({ page }, info) => {
  const backend = info.project.name.endsWith('webgl2') ? 'webgl2' : 'webgpu';
  await page.goto(`/?e2e&backend=${backend}`);
  await expect
    .poll(() => page.evaluate(() => window.__AETHER_EXAMPLE__?.state()), { timeout: 20_000 })
    .toMatchObject({
      backend,
      environmentMode: 'hdr',
      backgroundMode: 'hdr',
      diagnostics: { status: 'rendered', indexedDrawCalls: 10, indexCount: 360 }
    });
  const initial = await page.evaluate(() => window.__AETHER_EXAMPLE__!.state());
  const screenshotDiffRatio = backend === 'webgpu' ? 0.05 : 0.01;
  expectBackendClean(initial, backend);
  await page.evaluate(() => window.__AETHER_EXAMPLE__!.setRotation(Math.PI / 6));
  const initialFrame = (initial.diagnostics as { frame: number }).frame;
  await expect.poll(() => cleanFrame(page, backend)).toBeGreaterThan(initialFrame);
  await expect(page.locator('canvas')).toHaveScreenshot('react-vite-standard-lit-box.png', {
    animations: 'disabled',
    maxDiffPixelRatio: screenshotDiffRatio
  });
  const firstPose = await page.locator('canvas').screenshot();
  const firstPoseFrame = await page.evaluate(
    () => (window.__AETHER_EXAMPLE__!.state().diagnostics as { frame: number }).frame
  );
  await page.evaluate(() => window.__AETHER_EXAMPLE__!.setRotation(-Math.PI / 6));
  await expect.poll(() => cleanFrame(page, backend)).toBeGreaterThan(firstPoseFrame);
  expect(await page.locator('canvas').screenshot()).not.toEqual(firstPose);

  await page.evaluate(() => window.__AETHER_EXAMPLE__!.resize(640, 360));
  await expect
    .poll(() => page.evaluate(() => window.__AETHER_EXAMPLE__!.state()))
    .toMatchObject({ diagnostics: { status: 'rendered', surfaceGeneration: 2 } });
  expectBackendClean(await page.evaluate(() => window.__AETHER_EXAMPLE__!.state()), backend);

  await page.evaluate(() => window.__AETHER_EXAMPLE__!.resize(0, 0));
  await expect
    .poll(() => page.evaluate(() => window.__AETHER_EXAMPLE__!.state()))
    .toMatchObject({
      diagnostics: { status: 'skipped', reason: 'surface-suspended', surfaceGeneration: 3 }
    });
  expectBackendClean(await page.evaluate(() => window.__AETHER_EXAMPLE__!.state()), backend);

  await page.evaluate(() => window.__AETHER_EXAMPLE__!.resize(800, 450));
  await expect
    .poll(() => page.evaluate(() => window.__AETHER_EXAMPLE__!.state()))
    .toMatchObject({ diagnostics: { status: 'rendered', surfaceGeneration: 4 } });
  const recovered = await page.evaluate(() => window.__AETHER_EXAMPLE__!.state());
  expectBackendClean(recovered, backend);
  await expect(page.locator('canvas')).toHaveScreenshot('react-vite-standard-lit-recovered.png', {
    animations: 'disabled',
    maxDiffPixelRatio: screenshotDiffRatio
  });
  await info.attach('react-vite-state', {
    body: JSON.stringify({ initial, recovered }, null, 2),
    contentType: 'application/json'
  });
});

function expectBackendClean(state: Record<string, unknown>, backend: string): void {
  expect(state.runtimeErrors, JSON.stringify(state)).toEqual([]);
  expect(state.validationErrors, JSON.stringify(state)).toEqual([]);
  if (backend !== 'webgl2') return;
  expect(state.nativeError, JSON.stringify(state)).toBe(0);
  const metrics = state.nativeMetrics as Record<string, unknown>;
  expect(metrics.failed, JSON.stringify(state)).toBe(0);
  expect(Number(metrics.logicalDraws), JSON.stringify(state)).toBeGreaterThan(0);
  expect(Number(metrics.physicalDraws), JSON.stringify(state)).toBeGreaterThan(0);
}

async function cleanFrame(page: Page, backend: string): Promise<number> {
  const state = await page.evaluate(() => window.__AETHER_EXAMPLE__!.state());
  expectBackendClean(state, backend);
  return (state.diagnostics as { frame: number }).frame;
}
