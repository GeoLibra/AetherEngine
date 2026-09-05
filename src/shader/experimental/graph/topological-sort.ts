/**
 * @file Pure functional topological ordering and three-color cycle detection for ShaderGraph.
 * Domain nodes are treated as pure data without base class inheritance (composition-first).
 */

import type { ShaderGraphNode, ShaderNodeConnection } from './types';

export interface TopologicalSortSuccess {
  readonly ok: true;
  readonly order: readonly ShaderGraphNode[];
}

export interface TopologicalSortCycleError {
  readonly ok: false;
  readonly error: 'cycle';
  readonly nodeId: string;
}

export interface TopologicalSortMissingNodeError {
  readonly ok: false;
  readonly error: 'missing_node';
  readonly nodeId: string;
}

export type TopologicalSortResult =
  TopologicalSortSuccess | TopologicalSortCycleError | TopologicalSortMissingNodeError;

/**
 * Resolves the source node ID from a connection definition or shorthand string.
 */
export function resolveConnectionNodeId(connection: string | ShaderNodeConnection): string {
  return typeof connection === 'string' ? connection : connection.nodeId;
}

/**
 * Topologically sorts reachable nodes in the graph starting from root targets.
 * Detects cycles using three-color marking and rejects dangling/missing nodes.
 *
 * @param nodes All nodes present in the graph.
 * @param rootTargets Output targets or roots to traverse backwards from.
 * @returns Execution order array or structured topological error.
 */
export function topologicalSortGraph(
  nodes: readonly ShaderGraphNode[],
  rootTargets: readonly (string | ShaderNodeConnection)[]
): TopologicalSortResult {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const order: ShaderGraphNode[] = [];
  const active = new Set<string>();
  const done = new Set<string>();

  const visit = (
    id: string
  ): TopologicalSortCycleError | TopologicalSortMissingNodeError | undefined => {
    if (active.has(id)) {
      return { ok: false, error: 'cycle', nodeId: id };
    }
    if (done.has(id)) {
      return undefined;
    }
    const node = nodeMap.get(id);
    if (!node) {
      return { ok: false, error: 'missing_node', nodeId: id };
    }
    active.add(id);

    for (const rawConn of Object.values(node.inputs ?? {})) {
      const depId = resolveConnectionNodeId(rawConn);
      const error = visit(depId);
      if (error) {
        return error;
      }
    }

    active.delete(id);
    done.add(id);
    order.push(node);
    return undefined;
  };

  for (const root of rootTargets) {
    const rootId = resolveConnectionNodeId(root);
    const error = visit(rootId);
    if (error) {
      return error;
    }
  }

  return Object.freeze({ ok: true, order: Object.freeze(order) });
}
