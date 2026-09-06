import { expect, test } from '../fixtures/harness';

test('WebGL2 renders through the Aether surface and submission chain', async ({ harness }) => {
  const state = await harness.state();

  expect(state, JSON.stringify(state)).toMatchObject({
    status: 'ready',
    host: 'browser',
    backend: 'webgl2',
    detail: {
      renderPath: 'opaque-render-system',
      surfaceGeneration: 1,
      format: 'rgba8unorm',
      renderPasses: 1,
      drawCalls: 0,
      indexedDrawCalls: 2,
      nativeQueueSubmits: 1,
      glCalls: expect.any(Number),
      glErrors: [0, 0, 0, 0, 0],
      centerPixel: expect.any(Array),
      presentedPixel: expect.any(Array)
    }
  });
  if (state.status === 'ready') {
    expect((state.detail.centerPixel as number[])[3], JSON.stringify(state.detail)).toBe(255);
    expect(state.detail.centerPixel, JSON.stringify(state.detail)).not.toEqual([10, 31, 61, 255]);
    expect(state.detail.presentedPixel, JSON.stringify(state.detail)).toEqual(
      state.detail.centerPixel
    );
  }
  await expect(harness.page.locator('canvas')).toHaveScreenshot('webgl2-indexed-cube.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01
  });
});

test('WebGL2 stays error-free across resize, zero extent, and surface generations', async ({
  harness
}) => {
  await harness.resize(320, 180, 1);
  let state = await harness.state();
  expect(state).toMatchObject({
    status: 'ready',
    backend: 'webgl2',
    detail: {
      physicalSize: [320, 180],
      surfaceGeneration: 2,
      rendered: true,
      nativeQueueSubmits: 2
    }
  });
  if (state.status === 'ready')
    expect((state.detail.glErrors as number[]).every((error) => error === 0)).toBe(true);

  await harness.resize(0, 0, 1);
  state = await harness.state();
  expect(state).toMatchObject({
    status: 'ready',
    backend: 'webgl2',
    detail: {
      physicalSize: [0, 0],
      surfaceGeneration: 3,
      rendered: false,
      nativeQueueSubmits: 2
    }
  });
  if (state.status === 'ready')
    expect((state.detail.glErrors as number[]).every((error) => error === 0)).toBe(true);

  await harness.resize(256, 144, 1);
  state = await harness.state();
  expect(state).toMatchObject({
    status: 'ready',
    backend: 'webgl2',
    detail: {
      physicalSize: [256, 144],
      surfaceGeneration: 4,
      rendered: true,
      nativeQueueSubmits: 3
    }
  });
  if (state.status === 'ready') {
    expect((state.detail.glErrors as number[]).every((error) => error === 0)).toBe(true);
    expect(state.detail.presentedPixel).toEqual(state.detail.centerPixel);
  }
  await expect(harness.page.locator('canvas')).toHaveScreenshot('webgl2-resized-recovered.png', {
    animations: 'disabled',
    maxDiffPixelRatio: 0.01
  });
});
