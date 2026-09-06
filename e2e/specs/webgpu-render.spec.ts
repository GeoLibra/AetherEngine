import { expect, test } from '../fixtures/harness';

test('WebGPU renders the clear, triangle, and indexed depth cube in one submission', async ({
  harness
}, testInfo) => {
  const state = await harness.state();
  await testInfo.attach('webgpu-state', {
    body: JSON.stringify(state, null, 2),
    contentType: 'application/json'
  });
  expect(state, JSON.stringify(state)).toMatchObject({
    status: 'ready',
    host: 'browser',
    backend: 'webgpu',
    detail: {
      renderPath: 'opaque-render-system',
      generation: expect.any(Number),
      surfaceGeneration: 1,
      // Preferred canvas format varies across platform drivers (e.g. rgba8unorm on Linux CI vs bgra8unorm on macOS/Windows).
      format: expect.stringMatching(/^(rgba8unorm|bgra8unorm)$/),
      colorSpace: 'srgb',
      alphaMode: 'opaque',
      renderPasses: 1,
      drawCalls: 0,
      indexedDrawCalls: 2,
      nativeQueueSubmits: 1,
      validationErrors: 0
    }
  });

  await expect(harness.page.locator('canvas')).toHaveScreenshot('webgpu-indexed-cube.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01
  });
});

test('WebGPU stays validation-clean across resize, zero extent, and surface generations', async ({
  harness
}) => {
  await harness.resize(320, 180, 1);
  expect(await harness.state()).toMatchObject({
    status: 'ready',
    backend: 'webgpu',
    detail: {
      physicalSize: [320, 180],
      surfaceGeneration: 2,
      rendered: true,
      nativeQueueSubmits: 2,
      validationErrors: 0
    }
  });

  await harness.resize(0, 0, 1);
  expect(await harness.state()).toMatchObject({
    status: 'ready',
    backend: 'webgpu',
    detail: {
      physicalSize: [0, 0],
      surfaceGeneration: 3,
      rendered: false,
      nativeQueueSubmits: 2,
      validationErrors: 0
    }
  });

  await harness.resize(256, 144, 1);
  expect(await harness.state()).toMatchObject({
    status: 'ready',
    backend: 'webgpu',
    detail: {
      physicalSize: [256, 144],
      surfaceGeneration: 4,
      rendered: true,
      nativeQueueSubmits: 3,
      validationErrors: 0
    }
  });
  await expect(harness.page.locator('canvas')).toHaveScreenshot('webgpu-resized-recovered.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01
  });
});
