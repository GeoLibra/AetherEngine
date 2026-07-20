import { expect, test } from '../fixtures/harness';

test('browser host publishes resize metrics and removes its canvas on teardown', async ({
  harness
}) => {
  await expect(harness.state()).resolves.toMatchObject({
    status: 'ready',
    host: 'browser',
    backend: 'browser-host',
    detail: {
      logicalSize: [640, 360],
      physicalSize: [640, 360],
      devicePixelRatio: 1
    }
  });

  await harness.resize(800, 450, 2);

  await expect(harness.state()).resolves.toMatchObject({
    status: 'ready',
    host: 'browser',
    backend: 'browser-host',
    detail: {
      logicalSize: [800, 450],
      physicalSize: [1600, 900],
      devicePixelRatio: 2
    }
  });

  await harness.teardown();
  await expect(harness.state()).resolves.toEqual({ status: 'destroyed' });
  await expect(harness.canvasCount()).resolves.toBe(0);
});
