import { describe, expect, test } from 'vitest';
import {
  App,
  DefaultPlugins,
  HeadlessHost,
  HostService,
  MinimalPlugins,
  createHostPlugin,
  definePlugin
} from '../../src';

describe('Host App integration', () => {
  test('publishes the injected Host as the main-scope singleton', async () => {
    const host = new HeadlessHost();
    const app = new App().addPlugin(createHostPlugin(host));

    await app.startup();

    expect(app.getService(HostService)).toBe(host);
    await app.destroy();
    expect(host.state).toBe('destroyed');
  });

  test('owns the Host even when no consumer resolves the service explicitly', async () => {
    const host = new HeadlessHost();
    const app = new App().addPlugin(createHostPlugin(host));

    await app.startup();
    await app.destroy();

    expect(host.state).toBe('destroyed');
  });

  test('awaits asynchronous Host disposal before App destruction completes', async () => {
    let releaseDestroy: (() => void) | undefined;
    const destroyGate = new Promise<void>((resolve) => {
      releaseDestroy = resolve;
    });
    class DelayedHost extends HeadlessHost {
      destroyCompleted = false;

      override async destroy(): Promise<void> {
        await destroyGate;
        super.destroy();
        this.destroyCompleted = true;
      }
    }
    const host = new DelayedHost();
    const app = new App().addPlugin(createHostPlugin(host));
    await app.startup();

    const destroying = app.destroy();
    await Promise.resolve();
    expect(host.destroyCompleted).toBe(false);
    releaseDestroy?.();
    await destroying;

    expect(host.destroyCompleted).toBe(true);
  });

  test('destroys the Host when another plugin fails before Host service resolution', async () => {
    const host = new HeadlessHost();
    const app = new App()
      .addPlugin(
        definePlugin({
          id: 'aether.early-ready-failure',
          build() {},
          ready: () => {
            throw new Error('not ready');
          }
        })
      )
      .addPlugin(createHostPlugin(host));

    await expect(app.startup()).rejects.toThrow('not ready');

    expect(host.state).toBe('destroyed');
  });

  test('keeps concrete Host choice out of default plugin groups', () => {
    expect(new MinimalPlugins().plugins().map((plugin) => plugin.id)).not.toContain(
      'aether.host'
    );
    expect(new DefaultPlugins().plugins().map((plugin) => plugin.id)).not.toContain(
      'aether.host'
    );
  });
});
