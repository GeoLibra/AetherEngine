import type { GraphPassDeclaration, RenderGraphSnapshot, SemanticEdge } from './builder';
import {
  deriveRenderGraphHazards,
  type RenderGraphHazardCounters,
  type RenderGraphHazardEdge
} from './hazards';

const COMPILED_RENDER_GRAPHS = new WeakMap<object, RenderGraphSnapshot>();

export interface RenderGraphSemanticEdge {
  readonly kind: 'semantic';
  readonly fromPassId: number;
  readonly toPassId: number;
}

export type CompiledRenderGraphEdge = RenderGraphHazardEdge | RenderGraphSemanticEdge;

export interface CulledRenderGraphPass {
  readonly passId: number;
  readonly id: string;
  readonly reason: 'unreachable-from-root';
}

export interface CompiledRenderGraphCounters extends RenderGraphHazardCounters {
  readonly totalPasses: number;
  readonly retainedPasses: number;
  readonly culledPasses: number;
  readonly hazardEdges: number;
  readonly semanticEdges: number;
  readonly edgeCount: number;
}

export interface CompiledRenderGraph {
  readonly graphId: number;
  readonly retainedPasses: readonly GraphPassDeclaration[];
  readonly order: readonly number[];
  readonly edges: readonly CompiledRenderGraphEdge[];
  readonly rootPassIds: readonly number[];
  readonly culledPasses: readonly CulledRenderGraphPass[];
  readonly counters: CompiledRenderGraphCounters;
}

export class RenderGraphSemanticHazardError extends Error {
  readonly semanticEdge: RenderGraphSemanticEdge;

  constructor(edge: RenderGraphSemanticEdge, fromName: string, toName: string) {
    super(
      `Semantic edge ${fromName} -> ${toName} reverses a required resource hazard path ${toName} -> ${fromName}.`
    );
    this.name = 'RenderGraphSemanticHazardError';
    this.semanticEdge = edge;
  }
}

export class RenderGraphCycleError extends Error {
  readonly passIds: readonly number[];
  readonly passChain: readonly string[];
  readonly edges: readonly CompiledRenderGraphEdge[];

  constructor(
    passIds: readonly number[],
    passChain: readonly string[],
    edges: readonly CompiledRenderGraphEdge[]
  ) {
    super(`Render graph cycle: ${formatCycle(passChain, edges)}`);
    this.name = 'RenderGraphCycleError';
    this.passIds = Object.freeze([...passIds]);
    this.passChain = Object.freeze([...passChain]);
    this.edges = Object.freeze([...edges]);
  }
}

/** Compiles one frozen authoring snapshot into the only retained pass schedule. */
export function compileRenderGraph(snapshot: RenderGraphSnapshot): CompiledRenderGraph {
  const hazardResult = deriveRenderGraphHazards(snapshot);
  const semanticEdges = snapshot.semanticEdges.map(toCompiledSemanticEdge);
  validatePassReferences(snapshot, hazardResult.edges, semanticEdges);
  rejectHazardReversal(snapshot, hazardResult.edges, semanticEdges);

  const allEdges: readonly CompiledRenderGraphEdge[] = Object.freeze([
    ...hazardResult.edges,
    ...semanticEdges
  ]);
  const rootPassIds = collectRoots(snapshot);
  const retained = collectPredecessorClosure(rootPassIds, allEdges);
  const edges = Object.freeze(
    allEdges.filter((edge) => retained.has(edge.fromPassId) && retained.has(edge.toPassId))
  );
  const order = stableTopologicalOrder(snapshot, retained, edges);
  const retainedPasses = Object.freeze(order.map((passId) => requiredPass(snapshot, passId)));
  const culledPasses = Object.freeze(
    snapshot.passes
      .filter((pass) => !retained.has(pass.token.passId))
      .sort(comparePassRegistration)
      .map((pass) =>
        Object.freeze({
          passId: pass.token.passId,
          id: pass.id,
          reason: 'unreachable-from-root' as const
        })
      )
  );

  const compiled = Object.freeze({
    graphId: snapshot.graphId,
    retainedPasses,
    order: Object.freeze(order),
    edges,
    rootPassIds: Object.freeze(rootPassIds),
    culledPasses,
    counters: Object.freeze({
      ...hazardResult.counters,
      totalPasses: snapshot.passes.length,
      retainedPasses: retainedPasses.length,
      culledPasses: culledPasses.length,
      hazardEdges: edges.filter((edge) => edge.kind !== 'semantic').length,
      semanticEdges: edges.filter((edge) => edge.kind === 'semantic').length,
      edgeCount: edges.length
    })
  });
  COMPILED_RENDER_GRAPHS.set(compiled, snapshot);
  return compiled;
}

/** @internal Execution-plan construction rejects caller-forged compiler lookalikes. */
export function isCompiledRenderGraph(value: unknown): value is CompiledRenderGraph {
  return typeof value === 'object' && value !== null && COMPILED_RENDER_GRAPHS.has(value);
}

/** @internal A compiler result is executable only with the exact snapshot it validated. */
export function isCompiledRenderGraphForSnapshot(
  value: unknown,
  snapshot: RenderGraphSnapshot
): value is CompiledRenderGraph {
  return (
    typeof value === 'object' && value !== null && COMPILED_RENDER_GRAPHS.get(value) === snapshot
  );
}

function toCompiledSemanticEdge(edge: SemanticEdge): RenderGraphSemanticEdge {
  return Object.freeze({
    kind: 'semantic',
    fromPassId: edge.fromPassId,
    toPassId: edge.toPassId
  });
}

function validatePassReferences(
  snapshot: RenderGraphSnapshot,
  hazards: readonly RenderGraphHazardEdge[],
  semantics: readonly RenderGraphSemanticEdge[]
): void {
  const passIds = new Set(snapshot.passes.map((pass) => pass.token.passId));
  for (const edge of [...hazards, ...semantics]) {
    if (!passIds.has(edge.fromPassId) || !passIds.has(edge.toPassId)) {
      throw new Error('Render graph edge references an unknown pass.');
    }
  }
  for (const terminal of snapshot.terminals) {
    if (!passIds.has(terminal.passId)) {
      throw new Error('Render graph terminal references an unknown pass.');
    }
  }
}

function rejectHazardReversal(
  snapshot: RenderGraphSnapshot,
  hazards: readonly RenderGraphHazardEdge[],
  semantics: readonly RenderGraphSemanticEdge[]
): void {
  const hazardAdjacency = adjacencyFor(hazards);
  for (const edge of semantics) {
    if (!pathExists(edge.toPassId, edge.fromPassId, hazardAdjacency)) continue;
    throw new RenderGraphSemanticHazardError(
      edge,
      requiredPass(snapshot, edge.fromPassId).id,
      requiredPass(snapshot, edge.toPassId).id
    );
  }
}

function pathExists(
  start: number,
  target: number,
  adjacency: ReadonlyMap<number, readonly number[]>
): boolean {
  const pending = [start];
  const visited = new Set<number>();
  while (pending.length > 0) {
    const current = pending.shift() as number;
    if (current === target) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    for (const next of adjacency.get(current) ?? []) pending.push(next);
  }
  return false;
}

function collectRoots(snapshot: RenderGraphSnapshot): number[] {
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

function collectPredecessorClosure(
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

function stableTopologicalOrder(
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

function requiredPass(snapshot: RenderGraphSnapshot, passId: number): GraphPassDeclaration {
  const pass = snapshot.passes.find((candidate) => candidate.token.passId === passId);
  if (pass === undefined) throw new Error(`Render graph references unknown pass ${passId}.`);
  return pass;
}

function comparePassIds(snapshot: RenderGraphSnapshot, first: number, second: number): number {
  return (
    requiredPass(snapshot, first).registrationIndex -
    requiredPass(snapshot, second).registrationIndex
  );
}

function comparePassRegistration(
  first: GraphPassDeclaration,
  second: GraphPassDeclaration
): number {
  return first.registrationIndex - second.registrationIndex;
}

function formatCycle(
  passChain: readonly string[],
  edges: readonly CompiledRenderGraphEdge[]
): string {
  return (
    edges.map((edge, index) => `${passChain[index]} -[${describeEdge(edge)}]-> `).join('') +
    (passChain[passChain.length - 1] ?? 'unknown')
  );
}

function describeEdge(edge: CompiledRenderGraphEdge): string {
  if (edge.kind === 'semantic') return 'SEMANTIC';
  return `${edge.kind.toUpperCase()} resource ${edge.resourceId} v${edge.version}`;
}
