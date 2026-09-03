/** @file Maps platform file events to canonical shader recook requests. */

import { resolve } from 'node:path';
import type { CookNodeId } from '../../src/assets/cook';
import type {
  ShaderSourceChangeBridgeOptions,
  ShaderSourceChangeDispatchResult,
  ShaderSourceWatchRegistration
} from './types';

const EMPTY_DISPATCH_RESULTS: readonly ShaderSourceChangeDispatchResult[] = Object.freeze([]);

/** Coalesces file events and dispatches canonical shader nodes in stable order. */
export class ShaderSourceChangeBridge {
  readonly #nodesByPath = new Map<string, Set<CookNodeId>>();
  readonly #registeredNodes = new Set<CookNodeId>();
  readonly #pendingNodes = new Set<CookNodeId>();
  readonly #recook: ShaderSourceChangeBridgeOptions['recook'];
  #pendingDispatch: Promise<readonly ShaderSourceChangeDispatchResult[]> | undefined;
  #disposed = false;

  constructor(options: ShaderSourceChangeBridgeOptions) {
    this.#recook = options.recook;
  }

  /** Registers source, sidecar, and resolved dependency paths for one shader node. */
  register(registration: ShaderSourceWatchRegistration): void {
    if (this.#disposed) throw new Error('Cannot register a disposed shader source change bridge.');
    if (this.#registeredNodes.has(registration.nodeId)) {
      throw new Error(`Shader source watch is already registered: ${registration.nodeId}`);
    }
    this.#registeredNodes.add(registration.nodeId);
    const paths = [
      registration.sourcePath,
      ...(registration.metadataPath === undefined ? [] : [registration.metadataPath]),
      ...(registration.watchedDependencyPaths ?? [])
    ];
    for (const path of new Set(paths.map(normalizePath))) {
      const nodes = this.#nodesByPath.get(path) ?? new Set<CookNodeId>();
      nodes.add(registration.nodeId);
      this.#nodesByPath.set(path, nodes);
    }
  }

  /** Queues a normalized file event; same-turn events for a node share one recook. */
  notify(path: string): Promise<readonly ShaderSourceChangeDispatchResult[]> {
    if (this.#disposed) return Promise.resolve(EMPTY_DISPATCH_RESULTS);
    const nodes = this.#nodesByPath.get(normalizePath(path));
    if (!nodes) return Promise.resolve(EMPTY_DISPATCH_RESULTS);
    for (const node of nodes) this.#pendingNodes.add(node);
    if (!this.#pendingDispatch) {
      this.#pendingDispatch = this.#scheduleDispatch();
    }
    return this.#pendingDispatch;
  }

  /** Stops future dispatch and discards queued file events. */
  dispose(): void {
    this.#disposed = true;
    this.#pendingNodes.clear();
    this.#nodesByPath.clear();
  }

  async #scheduleDispatch(): Promise<readonly ShaderSourceChangeDispatchResult[]> {
    await Promise.resolve();
    return this.#drain();
  }

  async #drain(): Promise<readonly ShaderSourceChangeDispatchResult[]> {
    const results: ShaderSourceChangeDispatchResult[] = [];
    while (this.#pendingNodes.size > 0 && !this.#disposed) {
      const nodes = [...this.#pendingNodes].sort();
      this.#pendingNodes.clear();
      for (const nodeId of nodes) {
        if (this.#disposed) break;
        results.push(Object.freeze({ nodeId, result: await this.#recook(nodeId) }));
      }
    }
    this.#pendingDispatch = undefined;
    return Object.freeze(results);
  }
}

function normalizePath(path: string): string {
  if (!path) throw new Error('Shader source watch path must be a non-empty string.');
  return resolve(path);
}
