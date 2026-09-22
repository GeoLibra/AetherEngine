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
      nativeQueueSubmits: 12,
      validationErrors: 0,
      lightListGolden: {
        matchesCpuOracle: true,
        directionalIndices: [0],
        headerCount: 2,
        lightIndexCount: 3,
        overflowed: true,
        zeroLights: true,
        zeroReceivers: true
      },
      clusterLightListGolden: {
        matchesCpuOracle: true,
        directionalIndices: [0],
        headerCount: 4,
        lightIndexCount: expect.any(Number),
        overflowed: false
      },
      textureCopyGolden: {
        matchesSource: true,
        integerMatchesSource: true,
        halfFloatMatchesSource: true,
        floatMatchesSource: true,
        singleChannelMatchesSource: true,
        twoChannelMatchesSource: true,
        srgbMatchesSource: true,
        bytes: [17, 61, 143, 255]
      }
    }
  });

  await expect(harness.page.locator('canvas')).toHaveScreenshot('webgpu-indexed-cube.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01
  });
});

test('WebGPU stays validation-clean across resize, zero extent, and surface generations', async ({
  harness
}, testInfo) => {
  await harness.resize(320, 180, 1);
  expect(await harness.state()).toMatchObject({
    status: 'ready',
    backend: 'webgpu',
    detail: {
      physicalSize: [320, 180],
      surfaceGeneration: 2,
      rendered: true,
      nativeQueueSubmits: 13,
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
      nativeQueueSubmits: 13,
      validationErrors: 0
    }
  });

  await harness.resize(256, 144, 1);
  const finalState = await harness.state();
  expect(finalState).toMatchObject({
    status: 'ready',
    backend: 'webgpu',
    detail: {
      physicalSize: [256, 144],
      surfaceGeneration: 4,
      rendered: true,
      nativeQueueSubmits: 14,
      validationErrors: 0
    }
  });
  await expect(harness.page.locator('canvas')).toHaveScreenshot('webgpu-resized-recovered.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01
  });
  await testInfo.attach('webgpu-resize-recovery-state', {
    body: JSON.stringify(finalState, null, 2),
    contentType: 'application/json'
  });
  await testInfo.attach('webgpu-resize-recovery-actual', {
    body: await harness.page.locator('canvas').screenshot(),
    contentType: 'image/png'
  });
});
