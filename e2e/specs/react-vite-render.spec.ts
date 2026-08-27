import { expect, test } from '@playwright/test';

declare global {
  interface Window {
    __AETHER_EXAMPLE__?: {
      state(): Record<string, unknown>;
      resize(width: number, height: number): void;
    };
  }
}

test('renders the public React example and survives surface suspension', async ({ page }, info) => {
  const backend = info.project.name.endsWith('webgl2') ? 'webgl2' : 'webgpu';
  await page.goto(`/?e2e&backend=${backend}`);
  await expect
    .poll(() => page.evaluate(() => window.__AETHER_EXAMPLE__?.state()))
    .toMatchObject({
      backend,
      diagnostics: { status: 'rendered', indexedDrawCalls: 1, indexCount: 36 }
    });
  const initial = await page.evaluate(() => window.__AETHER_EXAMPLE__!.state());
  if (backend === 'webgl2') {
    expect(initial.nativeError, JSON.stringify(initial)).toBe(0);
    const metrics = initial.nativeMetrics as Record<string, unknown>;
    expect(metrics.failed, JSON.stringify(initial)).toBe(0);
    expect(Number(metrics.logicalDraws), JSON.stringify(initial)).toBeGreaterThan(0);
    expect(Number(metrics.physicalDraws), JSON.stringify(initial)).toBeGreaterThan(0);
  }
  await expect(page.locator('canvas')).toHaveScreenshot('react-vite-standard-lit-box.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01
  });

  await page.evaluate(() => window.__AETHER_EXAMPLE__!.resize(0, 0));
  await expect
    .poll(() => page.evaluate(() => window.__AETHER_EXAMPLE__!.state()))
    .toMatchObject({ diagnostics: { status: 'skipped', reason: 'surface-suspended' } });

  await page.evaluate(() => window.__AETHER_EXAMPLE__!.resize(800, 450));
  await expect
    .poll(() => page.evaluate(() => window.__AETHER_EXAMPLE__!.state()))
    .toMatchObject({ diagnostics: { status: 'rendered', surfaceGeneration: 3 } });
  await info.attach('react-vite-state', {
    body: JSON.stringify(
      { initial, recovered: await page.evaluate(() => window.__AETHER_EXAMPLE__!.state()) },
      null,
      2
    ),
    contentType: 'application/json'
  });
});
