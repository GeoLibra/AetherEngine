import { ALL_FRUSTUM_PLANES, type Vec3 } from '../../math';
import type { RenderEntityId } from '../render-world';
import type { RenderView, WorldBounds } from '../visibility';
import { compareSpatialEntries, isSpatialEntryVisible } from './linear-culler';
import type { SpatialEntry, SpatialQueryCounters, StaticBvhProfile } from './types';

const NODE_STRIDE = 4;
const META_STRIDE = 3;
const LEAF = 1;

// These two views share one buffer so float-to-bit hashing never allocates inside the checksum loop.
const floatScratch = new Float32Array(1);
const uintScratch = new Uint32Array(floatScratch.buffer);

export interface PackedStaticBvh {
  readonly bounds: Float32Array;
  readonly childOrEntry: Uint32Array;
  readonly metadata: Uint32Array;
  readonly entityIds: Uint32Array;
  readonly boundsRevisions: Uint32Array;
  readonly entries: readonly SpatialEntry[];
  readonly nodeCount: number;
  readonly rootNode: number | null;
  readonly checksum: number;
  readonly depth: number;
  readonly packedBytes: number;
}

interface BuildNode {
  index?: number;
  bounds: readonly [number, number, number, number, number, number];
  entries?: readonly SpatialEntry[];
  left?: BuildNode;
  right?: BuildNode;
  layerUnion: number;
  depth: number;
}

export function buildPackedStaticBvh(
  input: readonly SpatialEntry[],
  profile: StaticBvhProfile = {}
): PackedStaticBvh {
  const leafSize = Math.max(1, Math.floor(profile.leafSize ?? 8));
  const maxDepth = Math.max(1, Math.floor(profile.maxDepth ?? 32));
  const normalized = [...input].sort(compareSpatialEntries);
  if (normalized.length === 0) return emptyPackedBvh();
  const root = buildNode(normalized, 0, leafSize, maxDepth);
  const nodes: BuildNode[] = [];
  const payload: SpatialEntry[] = [];
  flatten(root, nodes, payload);
  const bounds = new Float32Array(nodes.length * 6);
  const childOrEntry = new Uint32Array(nodes.length * NODE_STRIDE);
  const metadata = new Uint32Array(nodes.length * META_STRIDE);
  let payloadOffset = 0;
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index]!;
    bounds.set(node.bounds, index * 6);
    metadata[index * META_STRIDE] = node.entries ? LEAF : 0;
    metadata[index * META_STRIDE + 1] = node.layerUnion >>> 0;
    metadata[index * META_STRIDE + 2] = subtreeCount(node);
    if (node.entries) {
      childOrEntry[index * NODE_STRIDE + 2] = payloadOffset;
      childOrEntry[index * NODE_STRIDE + 3] = node.entries.length;
      payloadOffset += node.entries.length;
    } else {
      childOrEntry[index * NODE_STRIDE] = node.left!.index!;
      childOrEntry[index * NODE_STRIDE + 1] = node.right!.index!;
    }
  }
  const entityIds = Uint32Array.from(payload.map((entry) => entry.renderEntity));
  const boundsRevisions = Uint32Array.from(payload.map((entry) => entry.boundsRevision));
  const checksum = checksumArrays(bounds, childOrEntry, metadata, entityIds, boundsRevisions);
  return Object.freeze({
    bounds,
    childOrEntry,
    metadata,
    entityIds,
    boundsRevisions,
    entries: Object.freeze(payload),
    nodeCount: nodes.length,
    rootNode: 0,
    checksum,
    depth: Math.max(...nodes.map((node) => node.depth)),
    packedBytes:
      bounds.byteLength +
      childOrEntry.byteLength +
      metadata.byteLength +
      entityIds.byteLength +
      boundsRevisions.byteLength
  });
}

export function traversePackedStaticBvh(
  bvh: PackedStaticBvh,
  view: RenderView,
  current: ReadonlyMap<RenderEntityId, SpatialEntry>,
  counters: MutableSpatialCounters
): SpatialEntry[] {
  if (bvh.rootNode === null) return [];
  const visible: SpatialEntry[] = [];
  const stack: Array<readonly [number, number]> = [[bvh.rootNode, ALL_FRUSTUM_PLANES]];
  while (stack.length > 0) {
    const [node, mask] = stack.pop()!;
    counters.visitedNodes++;
    if ((bvh.metadata[node * META_STRIDE + 1]! & view.layerMask) === 0) {
      counters.prunedNodes++;
      continue;
    }
    let remaining = mask;
    if (view.frustum && mask !== 0) {
      const offset = node * 6;
      const result = view.frustum.classifyAabbValues(
        bvh.bounds[offset]!,
        bvh.bounds[offset + 1]!,
        bvh.bounds[offset + 2]!,
        bvh.bounds[offset + 3]!,
        bvh.bounds[offset + 4]!,
        bvh.bounds[offset + 5]!,
        mask
      );
      counters.planeTests += result.planeTests;
      if (result.intersection === 'outside') {
        counters.prunedNodes++;
        continue;
      }
      if (result.intersection === 'inside') counters.insideNodes++;
      remaining = result.planeMask;
    }
    if (bvh.metadata[node * META_STRIDE] === LEAF) {
      const first = bvh.childOrEntry[node * NODE_STRIDE + 2]!;
      const count = bvh.childOrEntry[node * NODE_STRIDE + 3]!;
      for (let index = first; index < first + count; index++) {
        counters.indexedCandidates++;
        const indexed = bvh.entries[index]!;
        const latest = current.get(indexed.renderEntity);
        if (!latest || latest.boundsRevision !== indexed.boundsRevision) {
          counters.staleIndexedSkipped++;
          continue;
        }
        const tested = isSpatialEntryVisible(view, latest);
        counters.planeTests += tested.planeTests;
        if (tested.visible) visible.push(latest);
      }
      continue;
    }
    const left = bvh.childOrEntry[node * NODE_STRIDE]!;
    const right = bvh.childOrEntry[node * NODE_STRIDE + 1]!;
    stack.push([right, remaining], [left, remaining]);
  }
  return visible;
}

export interface MutableSpatialCounters extends Omit<SpatialQueryCounters, never> {
  visitedNodes: number;
  prunedNodes: number;
  insideNodes: number;
  planeTests: number;
  indexedCandidates: number;
  staleIndexedSkipped: number;
  fallbackCandidates: number;
  duplicateCandidates: number;
  wholeViewFallbacks: number;
}

function buildNode(
  entries: readonly SpatialEntry[],
  depth: number,
  leafSize: number,
  maxDepth: number
): BuildNode {
  const bounds = unionBounds(entries);
  const layerUnion = entries.reduce((mask, entry) => mask | entry.layerMask, 0);
  if (entries.length <= leafSize || depth >= maxDepth)
    return { bounds, entries, layerUnion, depth };
  const axis = splitAxis(entries);
  const sorted = [...entries].sort(
    (left, right) =>
      centroid(left.bounds, axis) - centroid(right.bounds, axis) ||
      compareSpatialEntries(left, right)
  );
  const middle = Math.floor(sorted.length / 2);
  if (middle === 0 || middle === sorted.length) return { bounds, entries, layerUnion, depth };
  return {
    bounds,
    left: buildNode(sorted.slice(0, middle), depth + 1, leafSize, maxDepth),
    right: buildNode(sorted.slice(middle), depth + 1, leafSize, maxDepth),
    layerUnion,
    depth
  };
}

function flatten(node: BuildNode, nodes: BuildNode[], payload: SpatialEntry[]): void {
  // Record the pre-order index before descending so child references pack in O(1), not via O(N) searches.
  node.index = nodes.length;
  nodes.push(node);
  if (node.entries) payload.push(...node.entries);
  else {
    flatten(node.left!, nodes, payload);
    flatten(node.right!, nodes, payload);
  }
}

function unionBounds(
  entries: readonly SpatialEntry[]
): readonly [number, number, number, number, number, number] {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (const entry of entries) {
    const [min, max] = boundsAabb(entry.bounds);
    minX = Math.min(minX, min[0]);
    minY = Math.min(minY, min[1]);
    minZ = Math.min(minZ, min[2]);
    maxX = Math.max(maxX, max[0]);
    maxY = Math.max(maxY, max[1]);
    maxZ = Math.max(maxZ, max[2]);
  }
  return [minX, minY, minZ, maxX, maxY, maxZ];
}

function boundsAabb(bounds: WorldBounds): readonly [Vec3, Vec3] {
  if (bounds.kind === 'aabb') return [bounds.min, bounds.max];
  const [x, y, z] = bounds.center,
    radius = bounds.radius;
  return [
    [x - radius, y - radius, z - radius],
    [x + radius, y + radius, z + radius]
  ];
}

function splitAxis(entries: readonly SpatialEntry[]): 0 | 1 | 2 {
  // Scan centroid extents once; allocating per-axis arrays here would amplify GC across recursive splits.
  let minX = Infinity,
    maxX = -Infinity;
  let minY = Infinity,
    maxY = -Infinity;
  let minZ = Infinity,
    maxZ = -Infinity;
  for (const entry of entries) {
    const cx = centroid(entry.bounds, 0);
    const cy = centroid(entry.bounds, 1);
    const cz = centroid(entry.bounds, 2);
    if (cx < minX) minX = cx;
    if (cx > maxX) maxX = cx;
    if (cy < minY) minY = cy;
    if (cy > maxY) maxY = cy;
    if (cz < minZ) minZ = cz;
    if (cz > maxZ) maxZ = cz;
  }
  const extentX = maxX - minX;
  const extentY = maxY - minY;
  const extentZ = maxZ - minZ;
  return extentY > extentX && extentY >= extentZ
    ? 1
    : extentZ > extentX && extentZ > extentY
      ? 2
      : 0;
}

function centroid(bounds: WorldBounds, axis: 0 | 1 | 2): number {
  return bounds.kind === 'sphere'
    ? bounds.center[axis]
    : (bounds.min[axis] + bounds.max[axis]) * 0.5;
}

function subtreeCount(node: BuildNode): number {
  return node.entries?.length ?? subtreeCount(node.left!) + subtreeCount(node.right!);
}

function checksumArrays(...arrays: readonly ArrayLike<number>[]): number {
  let hash = 2166136261;
  for (const array of arrays)
    for (let index = 0; index < array.length; index++) {
      const value = array[index]!;
      let bits: number;
      if (Number.isInteger(value)) {
        bits = value >>> 0;
      } else {
        floatScratch[0] = value;
        bits = uintScratch[0]!;
      }
      hash = Math.imul(hash ^ bits, 16777619) >>> 0;
    }
  return hash;
}

function emptyPackedBvh(): PackedStaticBvh {
  return Object.freeze({
    bounds: new Float32Array(),
    childOrEntry: new Uint32Array(),
    metadata: new Uint32Array(),
    entityIds: new Uint32Array(),
    boundsRevisions: new Uint32Array(),
    entries: Object.freeze([]),
    nodeCount: 0,
    rootNode: null,
    checksum: 2166136261,
    depth: 0,
    packedBytes: 0
  });
}
