import type { WebGL2ContextControl } from './extension-types';

export function createWebGL2ContextControl(invalidate: () => void): WebGL2ContextControl {
  return Object.freeze({ invalidateExternalState: invalidate });
}
