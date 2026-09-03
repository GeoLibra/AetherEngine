import type { CookNodeId, ShaderRecookCoordinator } from '../../../src/assets/cook';
import type { ShaderSourceWatchRegistration } from '../../asset-cook';

/** Configuration for the Vite adapter over the durable shader recook pipeline. */
export interface ShaderCookHmrPluginOptions {
  readonly coordinator: Pick<ShaderRecookCoordinator, 'sourceChanged'>;
  readonly registrations: readonly ShaderSourceWatchRegistration[];
  readonly moduleIdForNode: (nodeId: CookNodeId) => string;
}
