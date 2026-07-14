import type { RHIExtensionToken } from '../extension-types';

export interface WebGL2ContextControl {
  invalidateExternalState(): void;
}

export const WebGL2ContextControlExtension: RHIExtensionToken<WebGL2ContextControl> = Object.freeze({
  id: Symbol('aether.rhi.webgl2.context-control'),
  name: 'aether.rhi.webgl2.context-control'
});
