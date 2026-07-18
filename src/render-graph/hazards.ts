import type { GraphReadAccess, GraphWriteAccess, RenderGraphSnapshot } from './builder';
import {
  fullBufferRange,
  fullTextureRange,
  normalizeBufferRange,
  normalizeTextureRange,
  rangesOverlap,
  type GraphRange,
  type TextureGraphRange
} from './ranges';
import type { GraphResourceRecord, InitializationInterval } from './resources';
import type { BufferRange, GraphResourceKind, TextureRange } from './types';

export type RenderGraphHazardKind = 'raw' | 'war' | 'waw';

export interface RenderGraphHazardEdge {
  readonly kind: RenderGraphHazardKind;
  readonly fromPassId: number;
  readonly toPassId: number;
  readonly resourceId: number;
  readonly resourceKind: GraphResourceKind;
  readonly version: number;
  readonly range: GraphRange;
  readonly fallback: boolean;
}

export interface RenderGraphHazardCounters {
  readonly accessesExamined: number;
  readonly overlapComparisons: number;
  readonly wholeResourceFallbacks: number;
}

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

/** Derives resource safety edges without mutating the frozen authoring snapshot. */
export function deriveRenderGraphHazards(snapshot: RenderGraphSnapshot): RenderGraphHazardResult {
  const counters: MutableCounters = {
    accessesExamined: snapshot.passes.reduce((sum, pass) => sum + pass.accesses.length, 0),
    overlapComparisons: 0,
    wholeResourceFallbacks: 0
  };
  const edges: RenderGraphHazardEdge[] = [];
  const reads = snapshot.passes.flatMap((pass) =>
    pass.accesses.filter((access): access is GraphReadAccess => access.kind === 'read')
  );
  const writes = snapshot.passes.flatMap((pass) =>
    pass.accesses.filter((access): access is GraphWriteAccess => access.kind === 'write')
  );

  for (const read of reads) addReadAfterWriteEdges(snapshot, read, edges, counters);
  addActiveTerminalDependencies(snapshot, edges, counters);

  for (const read of reads) {
    for (const write of writes) {
      if (
        read.handle.resourceId !== write.handle.resourceId ||
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

  for (let firstIndex = 0; firstIndex < writes.length; firstIndex += 1) {
    const first = writes[firstIndex] as GraphWriteAccess;
    for (let secondIndex = firstIndex + 1; secondIndex < writes.length; secondIndex += 1) {
      const second = writes[secondIndex] as GraphWriteAccess;
      if (
        first.handle.resourceId !== second.handle.resourceId ||
        first.handle.kind !== second.handle.kind ||
        first.passId === second.passId
      ) {
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
  const seen = new Set<string>();
  return edges.filter((edge) => {
    const key = `${edge.kind}:${edge.fromPassId}:${edge.toPassId}:${edge.resourceId}:${edge.version}:${rangeKey(edge.range)}:${edge.fallback}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function rangeKey(range: GraphRange): string {
  if (range.kind === 'buffer') return `b:${range.offset}:${range.end}`;
  return `t:${range.baseMipLevel}:${range.mipLevelEnd}:${range.baseArrayLayer}:${range.arrayLayerEnd}:${range.aspect}`;
}
