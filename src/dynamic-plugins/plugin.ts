import type { Plugin, ServiceToken } from '../app/types';
import { createServiceToken, definePlugin, serviceFactory } from '../app/utils';
import { DynamicPluginHost, type DynamicPluginHostOptions } from './host';

export const DynamicPluginHostService: ServiceToken<DynamicPluginHost> =
  createServiceToken<DynamicPluginHost>('dynamic-plugin-host');

export function createDynamicPluginHostPlugin(options: DynamicPluginHostOptions): Plugin {
  return definePlugin({
    id: 'aether.dynamic-plugin-host',
    build(app) {
      app.provideService(
        DynamicPluginHostService,
        serviceFactory(() => new DynamicPluginHost(options), {
          scope: 'main',
          dispose: async (host) => {
            await host.destroy();
          }
        })
      );
    }
  });
}
