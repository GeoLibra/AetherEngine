import { expect, test } from '../fixtures/harness';

test('WebGPU renders the clear, triangle, and indexed depth cube in one submission', async ({
  harness
}) => {
  const state = await harness.state();
  expect(state, JSON.stringify(state)).toMatchObject({
    status: 'ready',
    host: 'browser',
    backend: 'webgpu',
    detail: {
      generation: expect.any(Number),
      surfaceGeneration: 1,
      // Preferred canvas format varies across platform drivers (e.g. rgba8unorm on Linux CI vs bgra8unorm on macOS/Windows).
      format: expect.stringMatching(/^(rgba8unorm|bgra8unorm)$/),
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      renderPasses: 1,
      drawCalls: 1,
      indexedDrawCalls: 1,
      nativeQueueSubmits: 1,
      validationErrors: 0
    }
  });

  await expect(harness.page.locator('canvas')).toHaveScreenshot('webgpu-indexed-cube.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01
  });
});
