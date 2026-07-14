import type { DeviceLostInfo } from '../lifecycle-types';
import type { WebGL2NativeContextLostInfo } from './native-types';

export function createWebGL2LossDiagnostic(
  generation: number,
  info: WebGL2NativeContextLostInfo
): DeviceLostInfo {
  return Object.freeze({
    reason: info.reason === 'out-of-memory' ? 'out-of-memory' : 'context-lost',
    message: info.message ?? 'WebGL2 context was lost.',
    generation
  });
}
