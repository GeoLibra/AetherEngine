import type { RenderGraphSnapshot } from '../../builder/builder';
import type { CompiledRenderGraphEdge } from '../../types';
import { RenderGraphCycleError } from './errors';
import { comparePassIds, requiredPass } from './validation';

export function collectRoots(snapshot: RenderGraphSnapshot): number[] {
  const roots = new Set<number>();
  for (const terminal of snapshot.terminals) roots.add(terminal.passId);
  for (const pass of snapshot.passes) {
    if (pass.sideEffects.length > 0) roots.add(pass.token.passId);
  }
  return [...roots].sort(
    (first, second) =>
      requiredPass(snapshot, first).registrationIndex -
      requiredPass(snapshot, second).registrationIndex
  );
}

export function collectPredecessorClosure(
  roots: readonly number[],
  edges: readonly CompiledRenderGraphEdge[]
): Set<number> {
  const incoming = new Map<number, number[]>();
  for (const edge of edges) {
    const predecessors = incoming.get(edge.toPassId) ?? [];
    predecessors.push(edge.fromPassId);
    incoming.set(edge.toPassId, predecessors);
  }
  const retained = new Set<number>();
  const pending = [...roots];
  while (pending.length > 0) {
    const passId = pending.pop() as number;
    if (retained.has(passId)) continue;
    retained.add(passId);
    for (const predecessor of incoming.get(passId) ?? []) pending.push(predecessor);
  }
  return retained;
}

export function stableTopologicalOrder(
  snapshot: RenderGraphSnapshot,
  retained: ReadonlySet<number>,
  edges: readonly CompiledRenderGraphEdge[]
): number[] {
  const relationships = uniqueRelationships(edges);
  const indegree = new Map<number, number>();
  const outgoing = new Map<number, number[]>();
  for (const passId of retained) indegree.set(passId, 0);
  for (const [fromPassId, toPassId] of relationships) {
    indegree.set(toPassId, (indegree.get(toPassId) ?? 0) + 1);
    const targets = outgoing.get(fromPassId) ?? [];
    targets.push(toPassId);
    outgoing.set(fromPassId, targets);
  }

  const ready = [...retained]
    .filter((passId) => indegree.get(passId) === 0)
    .sort((first, second) => comparePassIds(snapshot, first, second));
  const order: number[] = [];
  while (ready.length > 0) {
    const passId = ready.shift() as number;
    order.push(passId);
    for (const target of outgoing.get(passId) ?? []) {
      const nextIndegree = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) {
        ready.push(target);
        ready.sort((first, second) => comparePassIds(snapshot, first, second));
      }
    }
  }

  if (order.length !== retained.size) throw shortestCycleError(snapshot, retained, edges);
  return order;
}

function shortestCycleError(
  snapshot: RenderGraphSnapshot,
  retained: ReadonlySet<number>,
  edges: readonly CompiledRenderGraphEdge[]
): RenderGraphCycleError {
  const adjacency = adjacencyFor(edges, snapshot);
  const starts = [...retained].sort((first, second) => comparePassIds(snapshot, first, second));
  let best: readonly number[] | undefined;

  for (const start of starts) {
    const pending: number[][] = [[start]];
    const shortestDepth = new Map<number, number>([[start, 0]]);
    while (pending.length > 0) {
      const path = pending.shift() as number[];
      if (best !== undefined && path.length >= best.length) continue;
      const current = path[path.length - 1] as number;
      for (const next of adjacency.get(current) ?? []) {
        if (next === start) {
          const cycle = [...path, start];
          if (best === undefined || cycle.length < best.length) best = cycle;
          continue;
        }
        if (path.includes(next)) continue;
        const depth = path.length;
        if ((shortestDepth.get(next) ?? Number.POSITIVE_INFINITY) < depth) continue;
        shortestDepth.set(next, depth);
        pending.push([...path, next]);
      }
    }
  }

  if (best === undefined) throw new Error('Render graph topology failed without a readable cycle.');
  const cycleEdges = best.slice(0, -1).map((fromPassId, index) => {
    const toPassId = best?.[index + 1] as number;
    const edge = edges.find(
      (candidate) => candidate.fromPassId === fromPassId && candidate.toPassId === toPassId
    );
    if (edge === undefined) throw new Error('Render graph cycle edge is missing.');
    return edge;
  });
  return new RenderGraphCycleError(
    best,
    best.map((passId) => requiredPass(snapshot, passId).id),
    cycleEdges
  );
}

function uniqueRelationships(
  edges: readonly CompiledRenderGraphEdge[]
): readonly [number, number][] {
  const seen = new Set<string>();
  const relationships: [number, number][] = [];
  for (const edge of edges) {
    const key = `${edge.fromPassId}:${edge.toPassId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relationships.push([edge.fromPassId, edge.toPassId]);
  }
  return relationships;
}

function adjacencyFor(
  edges: readonly { readonly fromPassId: number; readonly toPassId: number }[],
  snapshot?: RenderGraphSnapshot
): ReadonlyMap<number, readonly number[]> {
  const adjacency = new Map<number, number[]>();
  for (const [fromPassId, toPassId] of uniqueRelationships(
    edges as readonly CompiledRenderGraphEdge[]
  )) {
    const targets = adjacency.get(fromPassId) ?? [];
    targets.push(toPassId);
    adjacency.set(fromPassId, targets);
  }
  if (snapshot !== undefined) {
    for (const targets of adjacency.values()) {
      targets.sort((first, second) => comparePassIds(snapshot, first, second));
    }
  }
  return adjacency;
}
