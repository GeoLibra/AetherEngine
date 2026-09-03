/** @file Connects Vite file events to durable shader recooking and module invalidation. */

import type { ShaderRecookResult } from '../../src/assets/cook';
import { ShaderSourceChangeBridge } from './shader-source-change-bridge';
import type {
  ViteShaderHotUpdateContext,
  ViteShaderSourceChangeBridgeOptions,
  ViteShaderSourceWatchRegistration
} from './types';

/** Routes Vite HMR events through the shared shader dependency and recook pipeline. */
export class ViteShaderSourceChangeBridge {
  readonly #sourceChanges: ShaderSourceChangeBridge;
  readonly #moduleIdForNode: ViteShaderSourceChangeBridgeOptions['moduleIdForNode'];

  constructor(options: ViteShaderSourceChangeBridgeOptions) {
    this.#sourceChanges = new ShaderSourceChangeBridge({ recook: options.recook });
    this.#moduleIdForNode = options.moduleIdForNode;
  }

  /** Registers the complete source path closure for one shader cook node. */
  register(registration: ViteShaderSourceWatchRegistration): void {
    this.#sourceChanges.register(registration);
  }

  /** Recooks affected nodes and returns only modules backed by successfully staged revisions. */
  async handleHotUpdate<TModule extends object>(
    context: ViteShaderHotUpdateContext<TModule>
  ): Promise<readonly TModule[] | undefined> {
    const dispatches = await this.#sourceChanges.notify(context.file);
    if (dispatches.length === 0) return undefined;

    const modules = new Map<string, TModule>();
    for (const dispatch of dispatches) {
      for (const result of dispatch.result as readonly ShaderRecookResult[]) {
        if (result.status === 'failed') {
          context.reportError(formatFailure(result));
          continue;
        }
        if (result.status !== 'staged') continue;
        const moduleId = this.#moduleIdForNode(result.nodeId);
        const module = context.moduleGraph.getModuleById(moduleId);
        if (module) modules.set(moduleId, module);
      }
    }
    for (const module of modules.values()) context.moduleGraph.invalidateModule(module);
    return Object.freeze([...modules.values()]);
  }

  /** Stops future file-event dispatch. */
  dispose(): void {
    this.#sourceChanges.dispose();
  }
}

function formatFailure(result: ShaderRecookResult): string {
  return `[aether:shader-cook-hmr] Recook failed for ${result.nodeId}@${result.revision}: ${result.message ?? 'Unknown shader recook failure.'}`;
}
