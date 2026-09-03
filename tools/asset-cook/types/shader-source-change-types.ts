import type { CookNodeId } from '../../../src/assets/cook';

/** Source paths whose changes invalidate one canonical shader cook node. */
export interface ShaderSourceWatchRegistration {
  readonly nodeId: CookNodeId;
  readonly sourcePath: string;
  readonly metadataPath?: string;
  readonly watchedDependencyPaths?: readonly string[];
}

/** External recook callback used by filesystem and Vite watcher adapters. */
export interface ShaderSourceChangeBridgeOptions {
  readonly recook: (nodeId: CookNodeId) => Promise<unknown>;
}

/** One completed source-change dispatch. */
export interface ShaderSourceChangeDispatchResult {
  readonly nodeId: CookNodeId;
  readonly result: unknown;
}

/** Minimal close handle shared by native and injected filesystem watchers. */
export interface SourceWatchHandle {
  close(): void;
}

/** Injectable Node watcher factory used to isolate operating-system events in tests. */
export type SourceWatchFactory = (
  path: string,
  listener: (filename?: string | null) => void
) => SourceWatchHandle;

/** Node filesystem watcher construction options. */
export interface FileSystemShaderSourceWatcherOptions extends ShaderSourceChangeBridgeOptions {
  readonly watch?: SourceWatchFactory;
  readonly onError?: (error: unknown) => void;
}
