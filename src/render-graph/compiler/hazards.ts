import {
  fullBufferRange,
  fullTextureRange,
  normalizeBufferRange,
  normalizeTextureRange,
  rangesOverlap,
  type BufferGraphRange,
  type GraphRange,
  type TextureGraphRange
} from '../ranges';
import type {
  BufferRange,
  GraphAccess,
  GraphReadAccess,
  GraphResourceKind,
  GraphResourceRecord,
  GraphWriteAccess,
  InitializationInterval,
  RenderGraphSnapshot,
  TextureRange
} from '../types';
import type {
  RenderGraphHazardCounters,
  RenderGraphHazardEdge,
  RenderGraphHazardKind
} from '../types';

export interface RenderGraphHazardResult {
  readonly edges: readonly RenderGraphHazardEdge[];
  readonly counters: RenderGraphHazardCounters;
}

interface MutableCounters {
  accessesExamined: number;
  overlapComparisons: number;
  wholeResourceFallbacks: number;
}

interface OverlapResult {
  readonly overlaps: boolean;
  readonly range: GraphRange;
  readonly fallback: boolean;
}

interface ResourceAccessBucket {
  readonly reads: GraphReadAccess[];
  readonly writes: GraphWriteAccess[];
}

/** Derives resource safety edges without mutating the frozen authoring snapshot. */
export function deriveRenderGraphHazards(snapshot: RenderGraphSnapshot): RenderGraphHazardResult {
  const resourceCount = snapshot.resources.length;
  const buckets: ResourceAccessBucket[] = Array.from({ length: resourceCount }, () => ({
    reads: [],
    writes: []
  }));

  let accessesExamined = 0;
  const edges: RenderGraphHazardEdge[] = [];
  const counters: MutableCounters = {
    accessesExamined: 0,
    overlapComparisons: 0,
    wholeResourceFallbacks: 0
  };

  // Collect reads and writes per resource, preserving pass-order and RAW derivation
  for (let passIndex = 0; passIndex < snapshot.passes.length; passIndex += 1) {
    const pass = snapshot.passes[passIndex]!;
    accessesExamined += pass.accesses.length;
    for (let accessIndex = 0; accessIndex < pass.accesses.length; accessIndex += 1) {
      const access = pass.accesses[accessIndex]!;
      const bucket = buckets[access.handle.resourceId];
      if (access.kind === 'read') {
        if (bucket !== undefined) {
          bucket.reads.push(access);
        }
        addReadAfterWriteEdges(snapshot, access, edges, counters);
      } else if (bucket !== undefined) {
        bucket.writes.push(access);
      }
    }
  }
  counters.accessesExamined = accessesExamined;

  addActiveTerminalDependencies(snapshot, edges, counters);

  // Derive WAR hazards within each resource bucket
  for (let resourceId = 0; resourceId < resourceCount; resourceId += 1) {
    const bucket = buckets[resourceId]!;
    const reads = bucket.reads;
    const writes = bucket.writes;
    if (reads.length === 0 || writes.length === 0) continue;

    for (let readIndex = 0; readIndex < reads.length; readIndex += 1) {
      const read = reads[readIndex]!;
      for (let writeIndex = 0; writeIndex < writes.length; writeIndex += 1) {
        const write = writes[writeIndex]!;
        if (
          read.handle.kind !== write.handle.kind ||
          read.handle.version >= write.handle.version ||
          read.passId === write.passId
        ) {
          continue;
        }
        const resource = resourceFor(snapshot, read.handle.resourceId, read.handle.kind);
        const overlap = compareRanges(read.range, write.range, resource, counters);
        if (!overlap.overlaps) continue;
        edges.push(
          hazardEdge('war', read.passId, write.passId, resource, write.handle.version, overlap)
        );
      }
    }
  }

  // Derive WAW hazards within each resource bucket
  for (let resourceId = 0; resourceId < resourceCount; resourceId += 1) {
    const writes = buckets[resourceId]!.writes;
    const writeCount = writes.length;
    if (writeCount < 2) continue;

    for (let firstIndex = 0; firstIndex < writeCount; firstIndex += 1) {
      const first = writes[firstIndex]!;
      for (let secondIndex = firstIndex + 1; secondIndex < writeCount; secondIndex += 1) {
        const second = writes[secondIndex]!;
        if (first.handle.kind !== second.handle.kind || first.passId === second.passId) {
          continue;
        }
        const [earlier, later] =
          first.handle.version < second.handle.version ? [first, second] : [second, first];
        if (earlier.handle.version === later.handle.version) continue;
        const resource = resourceFor(snapshot, earlier.handle.resourceId, earlier.handle.kind);
        const overlap = compareRanges(earlier.range, later.range, resource, counters);
        if (!overlap.overlaps) continue;
        edges.push(
          hazardEdge('waw', earlier.passId, later.passId, resource, later.handle.version, overlap)
        );
      }
    }
  }

  return Object.freeze({
    edges: Object.freeze(deduplicateEdges(edges)),
    counters: Object.freeze({ ...counters })
  });
}

function addReadAfterWriteEdges(
  snapshot: RenderGraphSnapshot,
  read: GraphReadAccess,
  edges: RenderGraphHazardEdge[],
  counters: MutableCounters
): void {
  const resource = resourceFor(snapshot, read.handle.resourceId, read.handle.kind);
  const version = resource.versions[read.handle.version];
  if (version === undefined) {
    throw new Error(`Render graph resource ${resource.resourceId} has an unknown read version.`);
  }
  addProducerEdges(read.passId, read.range, version.initialized, resource, edges, counters);
}

function addActiveTerminalDependencies(
  snapshot: RenderGraphSnapshot,
  edges: RenderGraphHazardEdge[],
  counters: MutableCounters
): void {
  for (const terminal of snapshot.terminals) {
    const resource = resourceFor(snapshot, terminal.handle.resourceId, terminal.handle.kind);
    const version = resource.versions[terminal.handle.version];
    if (version === undefined) {
      throw new Error(
        `Render graph resource ${resource.resourceId} has an unknown terminal version.`
      );
    }
    addProducerEdges(
      terminal.passId,
      fullRange(resource),
      version.initialized,
      resource,
      edges,
      counters
    );
  }
}

function addProducerEdges(
  consumerPassId: number,
  consumerRange: unknown,
  intervals: readonly InitializationInterval[],
  resource: GraphResourceRecord,
  edges: RenderGraphHazardEdge[],
  counters: MutableCounters
): void {
  for (const interval of intervals) {
    if (interval.producerPassId === null) continue;
    if (interval.producerPassId === consumerPassId) continue;
    const overlap = compareRanges(consumerRange, interval.range, resource, counters);
    if (!overlap.overlaps) continue;
    edges.push(
      hazardEdge(
        'raw',
        interval.producerPassId,
        consumerPassId,
        resource,
        interval.sourceVersion,
        overlap
      )
    );
  }
}

function compareRanges(
  first: unknown,
  second: unknown,
  resource: GraphResourceRecord,
  counters: MutableCounters
): OverlapResult {
  counters.overlapComparisons += 1;
  const normalizedFirst = normalizeKnownRange(first, resource);
  const normalizedSecond = normalizeKnownRange(second, resource);
  if (normalizedFirst === undefined || normalizedSecond === undefined) {
    counters.wholeResourceFallbacks += 1;
    return Object.freeze({ overlaps: true, range: fullRange(resource), fallback: true });
  }
  if (!rangesOverlap(normalizedFirst, normalizedSecond)) {
    return Object.freeze({ overlaps: false, range: normalizedFirst, fallback: false });
  }
  return Object.freeze({
    overlaps: true,
    range: intersectRanges(normalizedFirst, normalizedSecond),
    fallback: false
  });
}

function hazardEdge(
  kind: RenderGraphHazardKind,
  fromPassId: number,
  toPassId: number,
  resource: GraphResourceRecord,
  version: number,
  overlap: OverlapResult
): RenderGraphHazardEdge {
  return Object.freeze({
    kind,
    fromPassId,
    toPassId,
    resourceId: resource.resourceId,
    resourceKind: resource.kind,
    version,
    range: overlap.range,
    fallback: overlap.fallback
  });
}

function resourceFor(
  snapshot: RenderGraphSnapshot,
  resourceId: number,
  kind: GraphResourceKind
): GraphResourceRecord {
  const resource = snapshot.resources[resourceId];
  if (resource === undefined || resource.kind !== kind) {
    throw new Error(`Render graph access references unknown ${kind} resource ${resourceId}.`);
  }
  return resource;
}

function fullRange(resource: GraphResourceRecord): GraphRange {
  return resource.kind === 'texture'
    ? fullTextureRange(resource.descriptor)
    : fullBufferRange(resource.descriptor);
}

function normalizeKnownRange(
  value: unknown,
  resource: GraphResourceRecord
): GraphRange | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = value as Readonly<Record<string, unknown>>;
  try {
    if (resource.kind === 'buffer' && candidate.kind === 'buffer') {
      const normalized = normalizeBufferRange(
        resource.descriptor,
        candidate as unknown as BufferRange
      );
      return candidate.end === normalized.end ? normalized : undefined;
    }
    if (resource.kind === 'texture' && candidate.kind === 'texture') {
      const normalized = normalizeTextureRange(
        resource.descriptor,
        candidate as unknown as TextureRange
      );
      return candidate.mipLevelEnd === normalized.mipLevelEnd &&
        candidate.arrayLayerEnd === normalized.arrayLayerEnd
        ? normalized
        : undefined;
    }
  } catch {
    // A footprint that cannot be revalidated against its descriptor is unknown,
    // so the caller must conservatively order the whole logical resource.
  }
  return undefined;
}

function intersectRanges(first: GraphRange, second: GraphRange): GraphRange {
  if (first.kind === 'buffer' && second.kind === 'buffer') {
    const offset = Math.max(first.offset, second.offset);
    const end = Math.min(first.end, second.end);
    return Object.freeze({ kind: 'buffer', offset, size: end - offset, end });
  }
  if (first.kind === 'texture' && second.kind === 'texture') {
    const baseMipLevel = Math.max(first.baseMipLevel, second.baseMipLevel);
    const mipLevelEnd = Math.min(first.mipLevelEnd, second.mipLevelEnd);
    const baseArrayLayer = Math.max(first.baseArrayLayer, second.baseArrayLayer);
    const arrayLayerEnd = Math.min(first.arrayLayerEnd, second.arrayLayerEnd);
    return Object.freeze({
      kind: 'texture',
      baseMipLevel,
      mipLevelCount: mipLevelEnd - baseMipLevel,
      baseArrayLayer,
      arrayLayerCount: arrayLayerEnd - baseArrayLayer,
      aspect: intersectAspect(first, second),
      mipLevelEnd,
      arrayLayerEnd
    });
  }
  throw new Error('Cannot intersect render graph ranges of different resource kinds.');
}

function intersectAspect(
  first: TextureGraphRange,
  second: TextureGraphRange
): TextureGraphRange['aspect'] {
  if (first.aspect === 'all') return second.aspect;
  if (second.aspect === 'all') return first.aspect;
  return first.aspect;
}

function deduplicateEdges(edges: readonly RenderGraphHazardEdge[]): RenderGraphHazardEdge[] {
  if (edges.length <= 1) return edges.slice();
  const seenByPassPair = new Map<number, RenderGraphHazardEdge[]>();
  const result: RenderGraphHazardEdge[] = [];

  for (let i = 0; i < edges.length; i += 1) {
    const edge = edges[i]!;
    // Safe compound integer key for pass pair (fromPassId * 0x100000000 + toPassId)
    const pairKey = edge.fromPassId * 0x100000000 + edge.toPassId;
    const existing = seenByPassPair.get(pairKey);
    if (existing === undefined) {
      seenByPassPair.set(pairKey, [edge]);
      result.push(edge);
      continue;
    }

    let isDuplicate = false;
    for (let j = 0; j < existing.length; j += 1) {
      const prev = existing[j]!;
      if (
        prev.fromPassId === edge.fromPassId &&
        prev.toPassId === edge.toPassId &&
        prev.kind === edge.kind &&
        prev.resourceId === edge.resourceId &&
        prev.version === edge.version &&
        prev.fallback === edge.fallback &&
        sameGraphRange(prev.range, edge.range)
      ) {
        isDuplicate = true;
        break;
      }
    }

    if (!isDuplicate) {
      existing.push(edge);
      result.push(edge);
    }
  }

  return result;
}

function sameGraphRange(first: GraphRange, second: GraphRange): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === 'buffer') {
    const b1 = first as BufferGraphRange;
    const b2 = second as BufferGraphRange;
    return b1.offset === b2.offset && b1.end === b2.end;
  }
  const t1 = first as TextureGraphRange;
  const t2 = second as TextureGraphRange;
  return (
    t1.baseMipLevel === t2.baseMipLevel &&
    t1.mipLevelEnd === t2.mipLevelEnd &&
    t1.baseArrayLayer === t2.baseArrayLayer &&
    t1.arrayLayerEnd === t2.arrayLayerEnd &&
    t1.aspect === t2.aspect
  );
}
