import type {
  CompiledRenderGraphEdge,
  GraphPassDeclaration,
  RenderGraphHazardEdge,
  RenderGraphSemanticEdge,
  RenderGraphSnapshot,
  SemanticEdge
} from '../../types';
import { RenderGraphSemanticHazardError } from './errors';

export function toCompiledSemanticEdge(edge: SemanticEdge): RenderGraphSemanticEdge {
  return Object.freeze({
    kind: 'semantic',
    fromPassId: edge.fromPassId,
    toPassId: edge.toPassId
  });
}

export function validatePassReferences(
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

export function rejectHazardReversal(
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
  edges: readonly { readonly fromPassId: number; readonly toPassId: number }[]
): ReadonlyMap<number, readonly number[]> {
  const adjacency = new Map<number, number[]>();
  for (const [fromPassId, toPassId] of uniqueRelationships(
    edges as readonly CompiledRenderGraphEdge[]
  )) {
    const targets = adjacency.get(fromPassId) ?? [];
    targets.push(toPassId);
    adjacency.set(fromPassId, targets);
  }
  return adjacency;
}

export function requiredPass(snapshot: RenderGraphSnapshot, passId: number): GraphPassDeclaration {
  const pass = snapshot.passes.find((candidate) => candidate.token.passId === passId);
  if (pass === undefined) throw new Error(`Render graph references unknown pass ${passId}.`);
  return pass;
}

export function comparePassIds(
  snapshot: RenderGraphSnapshot,
  first: number,
  second: number
): number {
  return (
    requiredPass(snapshot, first).registrationIndex -
    requiredPass(snapshot, second).registrationIndex
  );
}

export function comparePassRegistration(
  first: GraphPassDeclaration,
  second: GraphPassDeclaration
): number {
  return first.registrationIndex - second.registrationIndex;
}
