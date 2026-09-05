/**
 * @file Asynchronous worker job orchestration, cancellation, and revision management for ShaderGraph.
 */

import type { ShaderGraph, ShaderGraphServiceResult, ShaderGraphWorkerPort } from './types';

/**
 * Manages asynchronous shader graph compilation jobs, cancellation, and last-known-good caching.
 */
export class ShaderGraphCompileService<T = unknown> {
  private readonly active = new Map<string, AbortController>();
  private readonly latest = new Map<string, number>();
  private readonly good = new Map<string, T>();

  constructor(private readonly worker: ShaderGraphWorkerPort<T>) {}

  /**
   * Enqueues or updates a compile request. Superseded requests with matching key are aborted.
   */
  async compile(
    request: Readonly<{ key: string; revision: number; priority: number; graph: ShaderGraph }>
  ): Promise<ShaderGraphServiceResult<T>> {
    this.active.get(request.key)?.abort('superseded');
    const controller = new AbortController();
    this.active.set(request.key, controller);
    this.latest.set(request.key, request.revision);

    try {
      const result = await this.worker.compile(
        Object.freeze({
          revision: request.revision,
          priority: request.priority,
          graph: request.graph,
          signal: controller.signal
        })
      );

      if (result.revision !== request.revision) {
        if (this.active.get(request.key) === controller) {
          this.active.delete(request.key);
        }
        return Object.freeze({ status: 'stale', revision: request.revision });
      }
      if (this.latest.get(request.key) !== request.revision) {
        if (this.active.get(request.key) === controller) {
          this.active.delete(request.key);
        }
        return Object.freeze({ status: 'stale', revision: request.revision });
      }
      if (controller.signal.aborted) {
        if (this.active.get(request.key) === controller) {
          this.active.delete(request.key);
        }
        return Object.freeze({ status: 'cancelled', revision: request.revision });
      }

      this.good.set(request.key, result.artifact);
      if (this.active.get(request.key) === controller) {
        this.active.delete(request.key);
      }
      return Object.freeze({
        status: 'completed',
        revision: request.revision,
        artifact: result.artifact
      });
    } catch (error) {
      if (this.active.get(request.key) === controller) {
        this.active.delete(request.key);
      }
      if (controller.signal.aborted) {
        return Object.freeze({ status: 'cancelled', revision: request.revision });
      }
      return Object.freeze({ status: 'failed', revision: request.revision, error });
    }
  }

  /**
   * Returns the last-known-good compiled artifact for a graph key.
   */
  lastKnownGood(key: string): T | undefined {
    return this.good.get(key);
  }

  /**
   * Explicitly cancels active compilation for a given key.
   */
  cancel(key: string, reason = 'cancelled'): void {
    this.active.get(key)?.abort(reason);
    this.active.delete(key);
  }
}

/**
 * Classifies an incremental change in a shader graph to determine minimal recompilation scope.
 */
export function classifyShaderGraphChange(
  change: Readonly<{
    kind:
      'parameter-value' | 'texture-binding' | 'sampler-binding' | 'topology' | 'type' | 'variant';
  }>
): 'parameter-update' | 'binding-update' | 'recompile' | 'variant-compile' {
  if (change.kind === 'parameter-value') {
    return 'parameter-update';
  }
  if (change.kind === 'texture-binding' || change.kind === 'sampler-binding') {
    return 'binding-update';
  }
  if (change.kind === 'variant') {
    return 'variant-compile';
  }
  return 'recompile';
}
