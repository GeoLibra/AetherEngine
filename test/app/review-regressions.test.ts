import { test, expect } from 'vitest';
import { App } from '../../src/app/app';

test('review: reentrant startup must return the shared promise', async () => {
  const app = new App();
  let nested: unknown;
  app.addPlugin({
    id: 'p',
    build() {
      nested = app.startup();
    }
  });
  const startup = app.startup();
  await startup;
  expect(nested).toBe(startup);
});

test('review: disabled telemetry must not sample the clock', async () => {
  let samples = 0;
  const app = new App({ telemetry: { enabled: false, clock: { now: () => ++samples } } });
  app.addPlugin({
    id: 'p',
    build(b) {
      b.addSystem('Update', { id: 's', run() {} });
    }
  });
  await app.startup();
  samples = 0;
  await app.run({
    async run(ctx) {
      ctx.frame(0);
      return { reason: 'done', frames: 1 };
    },
    requestStop() {}
  });
  expect(samples).toBe(0);
});

test('review: async set conditions must fail fast', async () => {
  const app = new App();
  let ran = false;
  app.addPlugin({
    id: 'p',
    build(b) {
      b.addSystemSet('Update', {
        id: 'set',
        runIf: (() => Promise.resolve(false)) as unknown as () => boolean
      });
      b.addSystem('Update', {
        id: 's',
        inSet: 'set',
        run() {
          ran = true;
        }
      });
    }
  });
  await app.startup();
  await expect(
    app.run({
      async run(ctx) {
        ctx.frame(0);
        return { reason: 'done', frames: 1 };
      },
      requestStop() {}
    })
  ).rejects.toThrow();
  expect(ran).toBe(false);
});

test('review: cancellation on final startup system must reject startup', async () => {
  const app = new App();
  let destruction: Promise<unknown> | undefined;
  app.addPlugin({
    id: 'p',
    build(b) {
      b.addSystem('PostStartup', {
        id: 's',
        run() {
          destruction = app.destroy();
        }
      });
    }
  });
  await expect(app.startup()).rejects.toThrow();
  await destruction;
});

test('review: abort-listener reentrant destroy shares the same cleanup', async () => {
  const app = new App();
  let nested: Promise<unknown> | undefined;
  let shutdowns = 0;
  app.addPlugin({
    id: 'p',
    build() {},
    prepare(ctx) {
      ctx.signal.addEventListener(
        'abort',
        () => {
          nested = app.destroy();
        },
        { once: true }
      );
    },
    shutdown() {
      shutdowns++;
    }
  });
  await app.startup();
  const outer = app.destroy();
  await outer;
  await nested;
  expect(shutdowns).toBe(1);
  expect(nested).toBe(outer);
});
