import { deriveRenderGraphHazards } from '../hazards';
import type {
  CompiledRenderGraph,
  CompiledRenderGraphCounters,
  CompiledRenderGraphEdge,
  CulledRenderGraphPass,
  RenderGraphSemanticEdge,
  RenderGraphSnapshot
} from '../../types';
import {
  rejectHazardReversal,
  requiredPass,
  toCompiledSemanticEdge,
  validatePassReferences,
  comparePassRegistration
} from './validation';
import { collectPredecessorClosure, collectRoots, stableTopologicalOrder } from './topology';

export { RenderGraphCycleError, RenderGraphSemanticHazardError } from './errors';

const COMPILED_RENDER_GRAPHS = new WeakMap<object, RenderGraphSnapshot>();

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
