import { describe, expect, it } from 'vitest';
import {
  DynamicCapabilityBroker,
  DynamicPluginHost,
  pluginActivationId
} from '../../src/dynamic-plugins';
import { createHost, definition, panelRegistry, pluginId, version } from './host-fixture';

describe('DynamicPluginHost updates', () => {
  it('preserves current when next fails and atomically switches when next succeeds', async () => {
    const panels = panelRegistry();
    const host = createHost(panels.provider);
    host.define(
      definition('v1', ({ capabilities }) => {
        capabilities.get(panels.provider.token).add('v1');
      })
    );
    host.define(
      definition('failing-v2', () => {
        throw new Error('next failed');
      })
    );
    host.define(
      definition('v2', ({ capabilities }) => {
        capabilities.get(panels.provider.token).add('v2');
      })
    );

    await host.activate(pluginId, version('v1'));
    await expect(host.activate(pluginId, version('failing-v2'))).rejects.toThrow('next failed');
    expect(host.current(pluginId)?.versionId).toBe(version('v1'));
    expect(panels.visible()).toEqual(['v1']);

    await host.activate(pluginId, version('v2'));

    expect(host.current(pluginId)?.versionId).toBe(version('v2'));
    expect(panels.visible()).toEqual(['v2']);
    expect(panels.observations()).not.toContainEqual(['v1', 'v2']);
  });

  it('retracts the current activation and destroys in reverse activation order', async () => {
    const panels = panelRegistry();
    const host = createHost(panels.provider);
    host.define(definition('v1', () => undefined));
    await host.activate(pluginId, version('v1'));

    const report = await host.retract(pluginId, 'user-request');

    expect(report?.terminalPhase).toBe('inactive');
    expect(host.current(pluginId)).toBeUndefined();
    expect(host.inventory()[0]?.phase).toBe('inactive');
    await host.destroy();
    await expect(host.activate(pluginId, version('v1'))).rejects.toThrow(/destroyed/i);
  });

  it('maintains new version current when previous version fails quiescence', async () => {
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
        wait: async () => {
          throw new Error('quiescence failed during update');
        }
      },
      quiescenceTimeoutMs: 50,
      mintActivationId: () => pluginActivationId(`act-${++activation}`)
    });

    host.define(
      definition('v1', ({ capabilities }) => {
        capabilities.get(panels.provider.token).add('v1');
      })
    );
    host.define(
      definition('v2', ({ capabilities }) => {
        capabilities.get(panels.provider.token).add('v2');
      })
    );

    await host.activate(pluginId, version('v1'));
    // Activating v2 commits v2, even though retracting v1 encounters quiescence failure
    const entry = await host.activate(pluginId, version('v2'));

    expect(entry.versionId).toBe(version('v2'));
    expect(host.current(pluginId)?.versionId).toBe(version('v2'));
    expect(panels.visible()).toEqual(['v2']);
  });
});
