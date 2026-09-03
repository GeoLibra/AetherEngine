/** @file Vite plugin boundary for the durable shader source recook pipeline. */

import type { ModuleNode, Plugin } from 'vite';
import { ViteShaderSourceChangeBridge } from '../asset-cook';
import type { ShaderCookHmrPluginOptions } from './types';

/** Creates a Vite HMR plugin that recooks registered shader dependency closures. */
export function shaderCookHmrPlugin(options: ShaderCookHmrPluginOptions): Plugin {
  const bridge = new ViteShaderSourceChangeBridge({
    recook: (nodeId) => options.coordinator.sourceChanged(nodeId),
    moduleIdForNode: options.moduleIdForNode
  });
  for (const registration of options.registrations) bridge.register(registration);

  return {
    name: 'aether:shader-cook-hmr',
    enforce: 'pre',

    async handleHotUpdate(context) {
      const modules = await bridge.handleHotUpdate<ModuleNode>({
        file: context.file,
        moduleGraph: context.server.moduleGraph,
        reportError: (message) => context.server.config.logger.error(message)
      });
      return modules === undefined ? undefined : [...modules];
    },

    closeBundle() {
      bridge.dispose();
    }
  };
}
