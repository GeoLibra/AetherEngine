import { expect, test } from '../fixtures/harness';

test('WebGL2 renders through the Aether surface and submission chain', async ({ harness }) => {
  const state = await harness.state();

  expect(state, JSON.stringify(state)).toMatchObject({
    status: 'ready',
    host: 'browser',
    backend: 'webgl2',
    detail: {
      surfaceGeneration: 1,
      format: 'rgba8unorm',
      renderPasses: 1,
      drawCalls: 1,
      indexedDrawCalls: 1,
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
