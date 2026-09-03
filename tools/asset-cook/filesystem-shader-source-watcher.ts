/** @file Node filesystem watcher lifecycle for shader authoring sources. */

import { watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { ShaderSourceChangeBridge } from './shader-source-change-bridge';
import type {
  FileSystemShaderSourceWatcherOptions,
  ShaderSourceWatchRegistration,
  SourceWatchFactory,
  SourceWatchHandle
} from './types';

const DEFAULT_WATCH: SourceWatchFactory = (path, listener) => watch(path, listener);

/** Owns concrete filesystem watches and forwards their events through a coalescing bridge. */
export class FileSystemShaderSourceWatcher {
  readonly #bridge: ShaderSourceChangeBridge;
  readonly #watch: SourceWatchFactory;
  readonly #onError: (error: unknown) => void;
  readonly #handles = new Map<string, SourceWatchHandle>();
  readonly #pathsByDirectory = new Map<string, Set<string>>();
  #disposed = false;

  constructor(options: FileSystemShaderSourceWatcherOptions) {
    this.#bridge = new ShaderSourceChangeBridge({ recook: options.recook });
    this.#watch = options.watch ?? DEFAULT_WATCH;
    this.#onError = options.onError ?? ((error) => console.error(error));
  }

  /** Registers a node and starts one operating-system watch for each unique input path. */
  register(registration: ShaderSourceWatchRegistration): void {
    if (this.#disposed) throw new Error('Cannot register a disposed filesystem shader watcher.');
    this.#bridge.register(registration);
    const paths = [
      registration.sourcePath,
      ...(registration.metadataPath === undefined ? [] : [registration.metadataPath]),
      ...(registration.watchedDependencyPaths ?? [])
    ].map((path) => resolve(path));
    for (const path of new Set(paths)) {
      const directory = dirname(path);
      const watchedPaths = this.#pathsByDirectory.get(directory) ?? new Set<string>();
      watchedPaths.add(path);
      this.#pathsByDirectory.set(directory, watchedPaths);
      if (this.#handles.has(directory)) continue;
      const handle = this.#watch(directory, (filename) => {
        const candidates = this.#pathsByDirectory.get(directory);
        if (!candidates) return;
        if (filename === undefined || filename === null) {
          for (const candidate of candidates) {
            void this.#bridge.notify(candidate).catch(this.#onError);
          }
          return;
        }
        const changedPath = resolve(join(directory, filename));
        if (!candidates.has(changedPath)) return;
        void this.#bridge.notify(changedPath).catch(this.#onError);
      });
      this.#handles.set(directory, handle);
    }
  }

  /** Closes every native watch and prevents queued changes from dispatching. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#bridge.dispose();
    for (const handle of this.#handles.values()) handle.close();
    this.#handles.clear();
    this.#pathsByDirectory.clear();
  }
}
