import type { CookNodeId, ShaderRecookResult } from '../../../src/assets/cook';
import type { ShaderSourceWatchRegistration } from './shader-source-change-types';

/** Opaque Vite module value owned by the server module graph. */
export type ViteShaderModule = object;

/** Vite module-graph operations consumed by the shader source-change adapter. */
export interface ViteShaderModuleGraphPort<TModule extends object> {
  getModuleById(id: string): TModule | undefined;
  invalidateModule(module: TModule): void;
}

/** Framework-neutral projection of the relevant Vite HMR context fields. */
export interface ViteShaderHotUpdateContext<TModule extends object> {
  readonly file: string;
  readonly moduleGraph: ViteShaderModuleGraphPort<TModule>;
  readonly reportError: (message: string) => void;
}

/** Construction contract for the Vite-to-cook source event bridge. */
export interface ViteShaderSourceChangeBridgeOptions {
  readonly recook: (nodeId: CookNodeId) => Promise<readonly ShaderRecookResult[]>;
  readonly moduleIdForNode: (nodeId: CookNodeId) => string;
}

/** Registration accepted by both filesystem and Vite source event adapters. */
export type ViteShaderSourceWatchRegistration = ShaderSourceWatchRegistration;
