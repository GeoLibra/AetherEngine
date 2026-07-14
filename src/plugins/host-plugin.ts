import type { Plugin, ServiceToken } from '../app/types';
import { createServiceToken, definePlugin, serviceValue } from '../app/utils';
import type { Host } from '../platform/types';

export const HostService: ServiceToken<Host> = createServiceToken<Host>('host');

export function createHostPlugin(host: Host): Plugin {
  let destroyPromise: Promise<void> | undefined;
  const destroyHost = (): Promise<void> => {
    destroyPromise ??= Promise.resolve().then(() => host.destroy());
    return destroyPromise;
  };
  return definePlugin({
    id: 'aether.host',
    build(builder) {
      builder.provideService(
        HostService,
        serviceValue(host, {
          scope: 'main',
          lifecycle: 'singleton',
          dispose: () => destroyHost()
        })
      );
    },
    shutdown() {
      // Plugin shutdown also covers startup failure before the service is resolved.
      return destroyHost();
    }
  });
}
