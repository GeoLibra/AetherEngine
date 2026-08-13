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
