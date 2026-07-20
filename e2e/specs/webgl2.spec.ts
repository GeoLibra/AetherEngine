import { expect, test } from '../fixtures/harness';

test('WebGL2 reports the selected backend or its exact unsupported failure', async ({
  harness
}) => {
  const state = await harness.state();

  if (process.env.CI) {
    expect(state, 'CI Chromium must provide a real WebGL2 context').toMatchObject({
      status: 'ready',
      host: 'browser',
      backend: 'webgl2'
    });
    return;
  }

  if (state.status === 'failed') {
    expect(state).toEqual({ status: 'failed', message: 'WebGL2 is unavailable.' });
    return;
  }

  expect(state).toMatchObject({
    status: 'ready',
    host: 'browser',
    backend: 'webgl2'
  });
});
