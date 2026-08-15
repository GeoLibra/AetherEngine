import type { RHIExtensionToken } from '../contracts/extension';
import type { WebGL2ContextControl } from './types';

export const WebGL2ContextControlExtension: RHIExtensionToken<WebGL2ContextControl> = Object.freeze(
  {
    id: Symbol('aether.rhi.webgl2.context-control'),
    name: 'aether.rhi.webgl2.context-control'
  }
);

export function createWebGL2ContextControl(invalidate: () => void): WebGL2ContextControl {
  return Object.freeze({ invalidateExternalState: invalidate });
}
