import { describe, expect, it } from 'vitest';
import {
  PanelToken,
  createHost,
  definition,
  panelRegistry,
  pluginId,
  version
} from './host-fixture';

describe('DynamicPluginHost lifecycle', () => {
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
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
