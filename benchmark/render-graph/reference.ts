import type { RenderGraphAccess, RenderGraphReferenceResult, RenderGraphWorkload } from './types';

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

export function runReferenceRenderGraph(workload: RenderGraphWorkload): RenderGraphReferenceResult {
  const edges = deriveHazardEdges(workload);
  const order = stableTopologicalOrder(workload.passes.length, edges);
  const passCount = workload.passes.length;
  const accessesExamined = passCount * workload.accessesPerPass;
  const overlapComparisons =
    ((passCount * (passCount - 1)) / 2) * workload.accessesPerPass * workload.accessesPerPass;

  return Object.freeze({
    order: Object.freeze(order),
    edgeChecksum: edgeChecksum(edges),
    retainedPasses: passCount,
    accessesExamined,
    overlapComparisons
  });
}

type Edge = readonly [from: number, to: number];

function deriveHazardEdges(workload: RenderGraphWorkload): readonly Edge[] {
  const edges: Edge[] = [];
  for (let earlierIndex = 0; earlierIndex < workload.passes.length; earlierIndex += 1) {
    const earlier = workload.passes[earlierIndex];
    if (earlier === undefined) throw new Error('RenderGraph workload pass list is incomplete.');
    for (let laterIndex = earlierIndex + 1; laterIndex < workload.passes.length; laterIndex += 1) {
      const later = workload.passes[laterIndex];
      if (later === undefined) throw new Error('RenderGraph workload pass list is incomplete.');
      if (accessesOverlapWithHazard(earlier.accesses, later.accesses)) {
        edges.push(Object.freeze([earlier.registrationIndex, later.registrationIndex]));
      }
    }
  }
  return Object.freeze(edges);
}

function accessesOverlapWithHazard(
  earlierAccesses: readonly RenderGraphAccess[],
  laterAccesses: readonly RenderGraphAccess[]
): boolean {
  let hasHazard = false;
  for (const earlier of earlierAccesses) {
    for (const later of laterAccesses) {
      if (
        earlier.resourceIndex === later.resourceIndex &&
        (earlier.mode === 'write' || later.mode === 'write')
      ) {
        hasHazard = true;
      }
    }
  }
  return hasHazard;
}

function stableTopologicalOrder(passCount: number, edges: readonly Edge[]): number[] {
  const adjacency = Array.from({ length: passCount }, () => [] as number[]);
  const indegrees = new Array<number>(passCount).fill(0);
  for (const [from, to] of edges) {
    adjacency[from]?.push(to);
    indegrees[to] = (indegrees[to] ?? 0) + 1;
  }
  const ready = indegrees.flatMap((indegree, index) => (indegree === 0 ? [index] : []));
  const order: number[] = [];

  while (ready.length > 0) {
    const passIndex = ready.shift();
    if (passIndex === undefined)
      throw new Error('RenderGraph reference ready queue is incomplete.');
    order.push(passIndex);
    for (const next of adjacency[passIndex] ?? []) {
      const nextIndegree = (indegrees[next] ?? 0) - 1;
      indegrees[next] = nextIndegree;
      if (nextIndegree === 0) insertByRegistrationIndex(ready, next);
    }
  }

  if (order.length !== passCount)
    throw new Error('RenderGraph reference workload contains a cycle.');
  return order;
}

function insertByRegistrationIndex(ready: number[], passIndex: number): void {
  const insertionIndex = ready.findIndex((candidate) => candidate > passIndex);
  if (insertionIndex === -1) ready.push(passIndex);
  else ready.splice(insertionIndex, 0, passIndex);
}

function edgeChecksum(edges: readonly Edge[]): string {
  let hash = FNV_OFFSET;
  for (const [from, to] of edges) {
    hash = hashText(`${from}>${to};`, hash);
  }
  return hash.toString(16).padStart(8, '0');
}

function hashText(value: string, initial: number): number {
  let hash = initial;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}
