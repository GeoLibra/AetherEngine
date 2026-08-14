import { describe, expect, it } from 'vitest';
import {
  DynamicCapabilityBroker,
  DynamicPluginHost,
  dynamicPluginId,
  pluginActivationId
} from '../../src/dynamic-plugins';
import {
  PanelToken,
  createHost,
  definition,
  panelRegistry,
  pluginId,
  version
} from './host-fixture';

describe('DynamicPluginHost lifecycle', () => {
  it('returns the shared destruction promise when an abort listener re-enters destroy', async () => {
    const panels = panelRegistry();
    const host = createHost(panels.provider);
    let reentrantDestroy: ReturnType<DynamicPluginHost['destroy']> | undefined;
    host.define(
      definition('reentrant-destroy', ({ signal }) => {
        signal.addEventListener('abort', () => {
          reentrantDestroy = host.destroy();
        });
      })
    );

    await host.activate(pluginId, version('reentrant-destroy'));
    const destroy = host.destroy();

    expect(reentrantDestroy).toBe(destroy);
    await expect(destroy).resolves.toEqual([]);
  });

  it('enumerates a frozen source-free definition before activation', () => {
    const panels = panelRegistry();
    const host = createHost(panels.provider);
    host.define(definition('v1', () => undefined));

    const inventory = host.inventory();

    expect(inventory).toMatchObject([{ phase: 'defined', versionId: version('v1') }]);
    expect(inventory[0]?.activationId).toBeUndefined();
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(JSON.stringify(inventory)).not.toContain('activate');
  });

  it('keeps activation contributions invisible until commit', async () => {
    const panels = panelRegistry();
    const host = createHost(panels.provider);
    const gate = deferred<void>();
    host.define(
      definition('v1', async ({ capabilities }) => {
        capabilities.get(PanelToken).add('panel');
        await gate.promise;
      })
    );

    const activation = host.activate(pluginId, version('v1'));

    expect(host.inventory()[0]?.phase).toBe('activating');
    expect(panels.visible()).toEqual([]);
    gate.resolve();
    await activation;
    expect(host.inventory()[0]?.phase).toBe('active');
    expect(panels.visible()).toEqual(['panel']);
  });

  it('rolls back a failed activation without visible contributions', async () => {
    const panels = panelRegistry();
    const host = createHost(panels.provider);
    host.define(
      definition('broken', ({ capabilities }) => {
        capabilities.get(PanelToken).add('panel');
        throw new Error('boom');
      })
    );

    await expect(host.activate(pluginId, version('broken'))).rejects.toThrow('boom');

    expect(panels.visible()).toEqual([]);
    expect(host.inventory()[0]?.phase).toBe('failed');
    expect(host.inventory()[0]?.diagnostic?.message).toBe('boom');
  });

  it('aborts and rolls back staging activation when host is destroyed in-flight', async () => {
    const panels = panelRegistry();
    const host = createHost(panels.provider);
    const gate = deferred<void>();
    host.define(
      definition('slow', async ({ capabilities }) => {
        capabilities.get(PanelToken).add('panel-staging');
        await gate.promise;
      })
    );

    const activationPromise = host.activate(pluginId, version('slow'));
    const destroyPromise = host.destroy();

    gate.resolve();
    await destroyPromise;
    await expect(activationPromise).rejects.toThrow(/destroyed/i);

    expect(panels.visible()).toEqual([]);
    expect(host.current(pluginId)).toBeUndefined();
  });

  it('bounds in-flight activation wait by quiescenceTimeoutMs deadline during destroy and tears down state', async () => {
    const panels = panelRegistry();
    const host = createHost(panels.provider);
    const entered = deferred<void>();
    host.define(
      definition('hanging', ({ capabilities }) => {
        capabilities.get(PanelToken).add('hanging-staging-panel');
        entered.resolve();
        return new Promise(() => undefined); // never resolves or settles
      })
    );

    const activationPromise = host.activate(pluginId, version('hanging'));
    await entered.promise;

    // host destroy should not hang forever; it completes within quiescenceTimeoutMs (50ms)
    const diagnostics = await host.destroy();

    expect(host.current(pluginId)).toBeUndefined();
    expect(panels.visible()).toEqual([]);
    const inventory = host.inventory();
    expect(inventory[0]?.phase).toBe('failed');
    expect(inventory[0]?.diagnostic?.code).toBe('DYNAMIC_PLUGIN_ACTIVATION_TIMEOUT');
    expect(diagnostics.map((d) => d.code)).toContain('DYNAMIC_PLUGIN_ACTIVATION_TIMEOUT');
  });

  it('completes destroy within deadline even when active plugin quiescence hangs forever', async () => {
    const panels = panelRegistry();
    let activation = 0;
    const broker = new DynamicCapabilityBroker('editor');
    broker.register(panels.provider);
    const host = new DynamicPluginHost({
      hostKind: 'editor',
      broker,
      verifier: { verify: () => true },
      policy: { authorize: () => 'granted' },
      quiescence: {
        wait: () => new Promise(() => undefined) // never resolves
      },
      quiescenceTimeoutMs: 50,
      mintActivationId: () => pluginActivationId(`act-${++activation}`)
    });

    host.define(
      definition('active-hanging-quiescence', ({ capabilities }) => {
        capabilities.get(PanelToken).add('active-panel');
      })
    );

    await host.activate(pluginId, version('active-hanging-quiescence'));
    expect(host.current(pluginId)?.phase).toBe('active');

    // host.destroy() must complete within quiescenceTimeoutMs (50ms)
    const diagnostics = await host.destroy();

    expect(host.current(pluginId)).toBeUndefined();
    expect(host.inventory()[0]?.phase).toBe('failed-to-quiesce');
  });

  it('reports live pendingWork and preserves deterministic sorted inventory', async () => {
    const panels = panelRegistry();
    const host = createHost(panels.provider);
    const pendingTask = deferred<void>();

    host.define(
      definition('worker', ({ track }) => {
        track(pendingTask.promise);
      })
    );

    await host.activate(pluginId, version('worker'));

    expect(host.current(pluginId)?.pendingWork).toBe(1);
    expect(host.inventory()[0]?.pendingWork).toBe(1);

    pendingTask.resolve();
    await Promise.resolve();

    expect(host.current(pluginId)?.pendingWork).toBe(0);
    expect(host.inventory()[0]?.pendingWork).toBe(0);
  });

  it('bounds aggregate destroy duration to a single shared deadline with multiple hanging plugins', async () => {
    const panels = panelRegistry();
    let activation = 0;
    const broker = new DynamicCapabilityBroker('editor');
    broker.register(panels.provider);
    const host = new DynamicPluginHost({
      hostKind: 'editor',
      broker,
      verifier: { verify: () => true },
      policy: { authorize: () => 'granted' },
      quiescence: {
        wait: () => new Promise(() => undefined) // never resolves
      },
      quiescenceTimeoutMs: 15,
      mintActivationId: () => pluginActivationId(`act-${++activation}`)
    });

    const pluginCount = 40;
    for (let i = 0; i < pluginCount; i++) {
      const pid = dynamicPluginId(`com.example.plugin${i}`);
      host.define({
        manifest: {
          schemaVersion: 1,
          pluginId: pid,
          versionId: version('v1'),
          hosts: [{ kind: 'editor', required: true }],
          capabilities: [],
          artifactHashes: {
            'plugin.js': 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
          }
        },
        activate: ({ own }) => {
          own(() => new Promise(() => undefined)); // hanging cleanup
        }
      });
      await host.activate(pid, version('v1'));
    }

    const start = Date.now();
    const diagnostics = await host.destroy();
    const elapsed = Date.now() - start;

    // Should complete in around 15-40ms (single shared timeout), NOT 40 * 15ms or 40 * 1ms serial accumulation
    expect(elapsed).toBeLessThan(50);
    const inventory = host.inventory();
    expect(inventory.length).toBe(pluginCount);
    for (const entry of inventory) {
      expect(entry.phase).toBe('failed-to-quiesce');
    }
  });

  it('aggregates and preserves all cleanup failures in diagnostics returned by destroy()', async () => {
    const panels = panelRegistry();
    const host = createHost(panels.provider);

    host.define(
      definition('multi-failure', ({ own }) => {
        own(() => {
          throw new Error('cleanup error 1');
        });
        own(() => {
          throw new Error('cleanup error 2');
        });
      })
    );

    await host.activate(pluginId, version('multi-failure'));
    const diagnostics = await host.destroy();

    const messages = diagnostics.map((d) => d.message);
    expect(messages).toContain('cleanup error 1');
    expect(messages).toContain('cleanup error 2');
  });

  it('still executes plugin scope cleanups even when capability lease retraction hangs forever', async () => {
    let cleanupExecuted = false;
    const hangingCapabilityProvider = {
      token: PanelToken,
      open: () => ({
        facade: { add: () => undefined },
        prepare: () => undefined,
        commit: () => undefined,
        rollback: () => new Promise<void>(() => undefined) // never resolves
      })
    };

    let activation = 0;
    const broker = new DynamicCapabilityBroker('editor');
    broker.register(hangingCapabilityProvider);
    const host = new DynamicPluginHost({
      hostKind: 'editor',
      broker,
      verifier: { verify: () => true },
      policy: { authorize: () => 'granted' },
      quiescence: { wait: async () => true },
      quiescenceTimeoutMs: 20,
      mintActivationId: () => pluginActivationId(`act-${++activation}`)
    });

    host.define(
      definition('hanging-cap-rollback', ({ own }) => {
        own(() => {
          cleanupExecuted = true;
        });
      })
    );

    await host.activate(pluginId, version('hanging-cap-rollback'));
    const diagnostics = await host.destroy();

    expect(cleanupExecuted).toBe(true);
    expect(host.current(pluginId)).toBeUndefined();
    expect(host.inventory()[0]?.phase).toBe('failed-to-quiesce');
  });

  it('bounds public host.retract() duration when capability retraction hangs forever and executes scope cleanups', async () => {
    let cleanupExecuted = false;
    const hangingCapabilityProvider = {
      token: PanelToken,
      open: () => ({
        facade: { add: () => undefined },
        prepare: () => undefined,
        commit: () => undefined,
        rollback: () => new Promise<void>(() => undefined) // never resolves
      })
    };

    let activation = 0;
    const broker = new DynamicCapabilityBroker('editor');
    broker.register(hangingCapabilityProvider);
    const host = new DynamicPluginHost({
      hostKind: 'editor',
      broker,
      verifier: { verify: () => true },
      policy: { authorize: () => 'granted' },
      quiescence: { wait: async () => true },
      quiescenceTimeoutMs: 15,
      mintActivationId: () => pluginActivationId(`act-${++activation}`)
    });

    host.define(
      definition('hanging-cap-retract-public', ({ own }) => {
        own(() => {
          cleanupExecuted = true;
        });
      })
    );

    await host.activate(pluginId, version('hanging-cap-retract-public'));

    const start = Date.now();
    const report = await host.retract(pluginId, 'user-request');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(45);
    expect(cleanupExecuted).toBe(true);
    expect(report?.terminalPhase).toBe('failed-to-quiesce');
    expect(host.current(pluginId)).toBeUndefined();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
