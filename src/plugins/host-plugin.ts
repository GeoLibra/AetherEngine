import type { Plugin, ServiceToken } from '../app/types';
import { createServiceToken, definePlugin, serviceValue } from '../app/utils';
import type { Host } from '../platform/types';

export const HostService: ServiceToken<Host> = createServiceToken<Host>('host');

export function createHostPlugin(host: Host): Plugin {
  return definePlugin({
    id: 'aether.host',
    build(builder) {
      builder.provideService(
        HostService,
        serviceValue(host, {
          scope: 'main',
          lifecycle: 'singleton',
          dispose: (ownedHost) => ownedHost.destroy()
        })
      );
    },
    ready(app) {
      // Resolve the owned value eagerly so disposal never depends on a consumer lookup.
      app.getService(HostService);
      return true;
    }
  });
}
