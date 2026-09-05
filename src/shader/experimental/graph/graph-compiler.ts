/**
 * @file ShaderGraph DAG compiler lowering typed node expressions into standard WGSL code.
 */

import { BoundedNodeCache } from './cache';
import type { ShaderGraph, ShaderGraphResult } from './types';
import { lowerGraphToIR } from './vertical-slice';

/**
 * Compiles a strongly typed visual ShaderGraph DAG into standard WGSL shader source code.
 */
export class ShaderGraphCompiler {
  private readonly nodeCache: BoundedNodeCache;

  constructor(options?: { cacheCapacity?: number }) {
    this.nodeCache = new BoundedNodeCache(options?.cacheCapacity ?? 1024);
  }

  /**
   * Validates graph topology, node types, and lowers nodes into standard WGSL.
   *
   * @param graph Authoring graph representation.
   * @param signal Optional cancellation signal.
   * @returns Successful compilation containing standard WGSL, or diagnostic errors.
   */
  async lower(graph: ShaderGraph, signal?: AbortSignal): Promise<ShaderGraphResult> {
    return lowerGraphToIR(graph, { nodeCache: this.nodeCache, signal });
  }

  /**
   * Synchronously validates and lowers graph using internal Merkle node cache.
   */
  lowerSync(graph: ShaderGraph): ShaderGraphResult {
    return lowerGraphToIR(graph, { nodeCache: this.nodeCache });
  }

  /**
   * Evaluates if a completed compile result matches the currently desired revision.
   */
  acceptResult(result: Readonly<{ revision: number }>, currentRevision: number): boolean {
    return result.revision === currentRevision;
  }
}
