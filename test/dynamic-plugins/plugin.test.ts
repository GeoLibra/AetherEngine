import { describe, expect, it } from 'vitest';
import { App } from '../../src';
import {
  DynamicCapabilityBroker,
  DynamicPluginHost,
  DynamicPluginHostService,
  createDynamicPluginHostPlugin,
  dynamicPluginId,
  pluginActivationId,
  pluginVersionId,
  type DynamicPluginHostOptions
} from '../../src/dynamic-plugins';

describe('dynamic plugin App integration', () => {
  it('installs the Host only when the opt-in static plugin is added', async () => {
    const app = new App();
    expect(() => app.getService(DynamicPluginHostService)).toThrow(/not registered/i);

    app.addPlugin(createDynamicPluginHostPlugin(hostOptions()));
    await app.startup();

    expect(app.getService(DynamicPluginHostService)).toBeInstanceOf(DynamicPluginHost);
  });

  it('destroys the dynamic Host through singleton service disposal', async () => {
    const app = new App().addPlugin(createDynamicPluginHostPlugin(hostOptions()));
    await app.startup();
    const host = app.getService(DynamicPluginHostService);

    await app.destroy();

    await expect(
      host.activate(dynamicPluginId('com.example.missing'), pluginVersionId('sha256:missing'))
    ).rejects.toThrow(/destroyed/i);
  });
});

function hostOptions(): DynamicPluginHostOptions {
  let activation = 0;
  return {
    hostKind: 'editor',
    broker: new DynamicCapabilityBroker('editor'),
    verifier: { verify: () => true },
    policy: { authorize: () => 'granted' },
    quiescence: { wait: async () => true },
    quiescenceTimeoutMs: 50,
    mintActivationId: () => pluginActivationId(`app-activation-${++activation}`)
  };
}
