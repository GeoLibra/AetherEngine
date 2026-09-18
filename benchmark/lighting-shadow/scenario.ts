import {
  ShadowAtlasAllocator,
  buildCpuClusters,
  buildCpuLightLists,
  buildClusterGrid,
  selectShadowRequests,
  type ClusterBuildResult,
  type ClusterCapacity,
  type ClusterDepthPolicy,
  type ClusterGrid,
  type ClusterSliceShape,
  type CpuLightListCapacity,
  type LightReceiver,
  type PreparedLight,
  type RenderEntityId,
  type ShadowBudget,
  type ShadowRequest,
  type WorldBounds
} from '../../src/rendering';
import { Mat4 } from '../../src/math';
import { STANDARD_DEPTH } from '../../src/math/depth';

export interface ShadowSelectionWorkload {
  readonly requests: readonly ShadowRequest[];
  readonly budget: ShadowBudget;
}

export interface CanonicalShadowSelection {
  readonly accepted: readonly RenderEntityId[];
  readonly rejected: readonly Readonly<{ entity: RenderEntityId; reason: string }>[];
  readonly usedTexels: number;
}

export function createShadowSelectionWorkload(count: number, seed = 113): ShadowSelectionWorkload {
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
  return Object.freeze({
    requests: Object.freeze(
      Array.from({ length: count }, (_, index) => {
        const resolutionClass = [16, 32, 64][index % 3]!;
        return Object.freeze({
          lightEntity: (count - index) as RenderEntityId,
          viewId: `view-${index % 4}`,
          kind:
            index % 3 === 0
              ? ('directional-cascade' as const)
              : index % 3 === 1
                ? ('spot' as const)
                : ('point-face' as const),
          subresourceIndex: index % 6,
          resolutionClass,
          importance: Math.floor(random() * 1000),
          casterRevision: index % 11
        });
      })
    ),
    budget: Object.freeze({
      maxRequests: Math.max(1, Math.floor(count * 0.55)),
      maxTexels: count * 1_300
    })
  });
}

export function runShadowSelectionSubject(
  workload: ShadowSelectionWorkload
): CanonicalShadowSelection {
  const selection = selectShadowRequests(workload.requests, workload.budget);
  return Object.freeze({
    accepted: Object.freeze(selection.accepted.map((request) => request.lightEntity)),
    rejected: Object.freeze(
      selection.rejected.map(({ request, reason }) =>
        Object.freeze({ entity: request.lightEntity, reason })
      )
    ),
    usedTexels: selection.usedTexels
  });
}

/** Independent scalar ordering and capacity oracle for shadow request selection. */
export function runShadowSelectionReference(
  workload: ShadowSelectionWorkload
): CanonicalShadowSelection {
  const ordered = [...workload.requests].sort(
    (left, right) =>
      right.importance - left.importance ||
      left.lightEntity - right.lightEntity ||
      left.viewId.localeCompare(right.viewId) ||
      left.kind.localeCompare(right.kind) ||
      left.subresourceIndex - right.subresourceIndex
  );
  const accepted: RenderEntityId[] = [];
  const rejected: Array<{ entity: RenderEntityId; reason: string }> = [];
  let usedTexels = 0;
  for (const request of ordered) {
    const texels = request.resolutionClass * request.resolutionClass;
    if (accepted.length >= workload.budget.maxRequests)
      rejected.push({ entity: request.lightEntity, reason: 'request-capacity' });
    else if (usedTexels + texels > workload.budget.maxTexels)
      rejected.push({ entity: request.lightEntity, reason: 'texel-capacity' });
    else {
      accepted.push(request.lightEntity);
      usedTexels += texels;
    }
  }
  return Object.freeze({
    accepted: Object.freeze(accepted),
    rejected: Object.freeze(rejected.map((entry) => Object.freeze(entry))),
    usedTexels
  });
}

export interface LightingWorkload {
  readonly lights: readonly PreparedLight[];
  readonly receivers: readonly LightReceiver[];
  readonly capacity: CpuLightListCapacity;
}

export interface CanonicalLightLists {
  readonly directionalEntities: readonly RenderEntityId[];
  readonly receivers: readonly Readonly<{
    receiver: RenderEntityId;
    lightEntities: readonly RenderEntityId[];
    overflowed: boolean;
  }>[];
  readonly counters: Readonly<{
    candidatePairs: number;
    intersectionTests: number;
    emittedIndices: number;
    overflowedReceivers: number;
    truncatedIndices: number;
  }>;
}

export interface CanonicalAtlasAllocation {
  readonly tiles: readonly Readonly<{
    key: string;
    generation: number;
    x: number;
    y: number;
    size: number;
  }>[];
  readonly allocatedTexels: number;
  readonly occupancy: number;
  readonly reclaimedLowerHole: boolean;
  readonly staleAfterInvalidate: boolean;
}

export interface CanonicalAtlasCompaction {
  readonly generation: number;
  readonly relocations: readonly Readonly<{
    key: string;
    previousX: number;
    nextX: number;
    previousGeneration: number;
    nextGeneration: number;
  }>[];
  readonly counters: Readonly<{
    inputTiles: number;
    relocations: number;
    validNextHandles: number;
    invalidPreviousHandles: number;
  }>;
  readonly checksum: string;
}

export function createLightingWorkload(
  receiverCount: number,
  lightCount: number,
  seed = 71,
  constrained = false
): LightingWorkload {
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
  const lights: PreparedLight[] = [];
  for (let index = 0; index < lightCount; index++) {
    const common = {
      entity: (lightCount - index) as RenderEntityId,
      payloadVersion: 1,
      colorLinear: [0.25 + random(), 0.25 + random(), 0.25 + random()] as const,
      enabled: index % 19 !== 0,
      layerMask: index % 17 === 0 ? 2 : 1,
      castsShadow: index % 3 === 0
    };
    if (index % 13 === 0) {
      lights.push({
        ...common,
        kind: 'directional',
        direction: [0.2, -1, -0.3],
        illuminanceLux: 50_000 + index
      });
    } else if (index % 3 === 0) {
      lights.push({
        ...common,
        kind: 'spot',
        position: randomPosition(random),
        direction: [0, -1, -1],
        luminousIntensityCandela: 500 + index,
        range: 3 + random() * 10,
        innerRadians: 0.2,
        outerRadians: 0.5
      });
    } else {
      lights.push({
        ...common,
        kind: 'point',
        position: randomPosition(random),
        luminousIntensityCandela: 500 + index,
        range: 3 + random() * 10
      });
    }
  }
  const receivers = Array.from({ length: receiverCount }, (_, index): LightReceiver => {
    const center = randomPosition(random);
    const radius = 0.25 + random() * 1.5;
    const bounds: WorldBounds =
      index % 2 === 0
        ? { kind: 'sphere', center, radius }
        : {
            kind: 'aabb',
            min: [center[0] - radius, center[1] - radius, center[2] - radius],
            max: [center[0] + radius, center[1] + radius, center[2] + radius]
          };
    return Object.freeze({
      renderEntity: (receiverCount - index + 10_000) as RenderEntityId,
      layerMask: index % 23 === 0 ? 2 : 1,
      enabled: index % 101 !== 0,
      bounds
    });
  });
  return Object.freeze({
    lights: Object.freeze(lights),
    receivers: Object.freeze(receivers),
    capacity: Object.freeze(
      constrained
        ? { maxDirectionalLights: 1, maxLightsPerReceiver: 4, maxLightIndices: receiverCount * 2 }
        : {
            maxDirectionalLights: lightCount,
            maxLightsPerReceiver: lightCount,
            maxLightIndices: receiverCount * lightCount
          }
    )
  });
}

export function runLightingSubject(workload: LightingWorkload): CanonicalLightLists {
  const result = buildCpuLightLists({
    viewLayerMask: 1,
    lights: workload.lights,
    receivers: workload.receivers,
    capacity: workload.capacity
  });
  return Object.freeze({
    directionalEntities: Object.freeze(
      result.globalDirectionalLightIndices.map((index) => result.orderedLights[index]!.entity)
    ),
    receivers: Object.freeze(
      result.headers.map((header) =>
        Object.freeze({
          receiver: header.receiver,
          lightEntities: Object.freeze(
            result.lightIndices
              .slice(header.offset, header.offset + header.count)
              .map((index) => result.orderedLights[index]!.entity)
          ),
          overflowed: header.overflowed
        })
      )
    ),
    counters: Object.freeze({
      candidatePairs: result.counters.candidatePairs,
      intersectionTests: result.counters.intersectionTests,
      emittedIndices: result.counters.emittedIndices,
      overflowedReceivers: result.counters.overflowedReceivers,
      truncatedIndices: result.counters.truncatedIndices
    })
  });
}

/** Independent scalar oracle; deliberately shares no production list or intersection helpers. */
export function runLightingReference(workload: LightingWorkload): CanonicalLightLists {
  const lights = [...workload.lights].sort((left, right) => left.entity - right.entity);
  const eligible = lights.filter((light) => light.enabled && (light.layerMask & 1) !== 0);
  const directional = eligible.filter((light) => light.kind === 'directional');
  const directionalEntities = directional
    .slice(0, workload.capacity.maxDirectionalLights)
    .map((light) => light.entity);
  const local = eligible.filter(
    (light): light is Exclude<PreparedLight, { readonly kind: 'directional' }> =>
      light.kind !== 'directional'
  );
  const receivers = [...workload.receivers]
    .sort((left, right) => left.renderEntity - right.renderEntity)
    .filter((receiver) => receiver.enabled !== false && (receiver.layerMask & 1) !== 0);
  const output: {
    receiver: RenderEntityId;
    lightEntities: readonly RenderEntityId[];
    overflowed: boolean;
  }[] = [];
  let emittedIndices = 0;
  let candidatePairs = 0;
  let intersectionTests = 0;
  let overflowedReceivers = 0;
  let truncatedIndices = 0;
  for (const receiver of receivers) {
    const selected: RenderEntityId[] = [];
    let overflowed = false;
    for (const light of local) {
      if ((light.layerMask & receiver.layerMask) === 0) continue;
      candidatePairs++;
      intersectionTests++;
      if (!referenceSphereIntersects(light.position, light.range, receiver.bounds)) continue;
      if (
        selected.length >= workload.capacity.maxLightsPerReceiver ||
        emittedIndices >= workload.capacity.maxLightIndices
      ) {
        overflowed = true;
        truncatedIndices++;
      } else {
        selected.push(light.entity);
        emittedIndices++;
      }
    }
    if (overflowed) overflowedReceivers++;
    output.push(
      Object.freeze({
        receiver: receiver.renderEntity,
        lightEntities: Object.freeze(selected),
        overflowed
      })
    );
  }
  return Object.freeze({
    directionalEntities: Object.freeze(directionalEntities),
    receivers: Object.freeze(output),
    counters: Object.freeze({
      candidatePairs,
      intersectionTests,
      emittedIndices,
      overflowedReceivers,
      truncatedIndices
    })
  });
}

export function runShadowAtlasSubject(
  columns: number,
  rows: number,
  tileSize: number
): CanonicalAtlasAllocation {
  const atlas = new ShadowAtlasAllocator({
    width: columns * tileSize,
    height: rows * tileSize
  });
  const tiles = Array.from({ length: columns * rows }, (_, index) => {
    const tile = atlas.allocate(`tile-${index}`, tileSize);
    if (tile === undefined) throw new Error('Deterministic shadow atlas workload did not fit.');
    return Object.freeze({
      key: tile.key,
      generation: tile.generation,
      x: tile.x,
      y: tile.y,
      size: tile.width
    });
  });
  const first = atlas.allocate('tile-0', tileSize)!;
  atlas.release(first.key);
  const replacement = atlas.allocate('replacement', tileSize);
  if (replacement === undefined) {
    throw new Error('Shadow atlas failed to reclaim a released lower hole.');
  }
  const metrics = atlas.metrics();
  atlas.invalidate();
  return Object.freeze({
    tiles: Object.freeze(tiles),
    allocatedTexels: metrics.allocatedTexels,
    occupancy: metrics.occupancy,
    reclaimedLowerHole: replacement.x === first.x && replacement.y === first.y,
    staleAfterInvalidate: !atlas.isValid(replacement)
  });
}

export function runShadowAtlasReference(
  columns: number,
  rows: number,
  tileSize: number
): CanonicalAtlasAllocation {
  const tiles = Array.from({ length: columns * rows }, (_, index) =>
    Object.freeze({
      key: `tile-${index}`,
      generation: 1,
      x: (index % columns) * tileSize,
      y: Math.floor(index / columns) * tileSize,
      size: tileSize
    })
  );
  return Object.freeze({
    tiles: Object.freeze(tiles),
    allocatedTexels: columns * rows * tileSize * tileSize,
    occupancy: 1,
    reclaimedLowerHole: true,
    staleAfterInvalidate: true
  });
}

export function runShadowAtlasCompactionSubject(
  count: number,
  tileSize: number
): CanonicalAtlasCompaction {
  assertAtlasScale(count, tileSize);
  const atlas = new ShadowAtlasAllocator({ width: count * tileSize, height: tileSize });
  const previous = Array.from({ length: count }, (_, index) => {
    const tile = atlas.allocate(`tile-${index}`, tileSize);
    if (tile === undefined) throw new Error('Shadow atlas compaction workload did not fit.');
    return tile;
  });
  const compacted = atlas.compact();
  if (compacted === undefined)
    throw new Error('Shadow atlas compaction workload failed to repack.');
  const relocations = compacted.relocations.map(({ key, previous: before, next }) =>
    Object.freeze({
      key,
      previousX: before.x,
      nextX: next.x,
      previousGeneration: before.generation,
      nextGeneration: next.generation
    })
  );
  const counters = Object.freeze({
    inputTiles: previous.length,
    relocations: compacted.relocations.length,
    validNextHandles: compacted.relocations.filter(({ next }) => atlas.isValid(next)).length,
    invalidPreviousHandles: previous.filter((handle) => !atlas.isValid(handle)).length
  });
  return atlasCompactionObservation(compacted.generation, relocations, counters);
}

/** Closed-form oracle for uniform one-row packing and code-unit key ordering. */
export function runShadowAtlasCompactionReference(
  count: number,
  tileSize: number
): CanonicalAtlasCompaction {
  assertAtlasScale(count, tileSize);
  const keys = Array.from({ length: count }, (_, index) => `tile-${index}`).sort(compareCodeUnits);
  const nextX = new Map(keys.map((key, index) => [key, index * tileSize]));
  const relocations = keys.map((key) => {
    const numericIndex = Number(key.slice('tile-'.length));
    return Object.freeze({
      key,
      previousX: numericIndex * tileSize,
      nextX: nextX.get(key)!,
      previousGeneration: 1,
      nextGeneration: 2
    });
  });
  return atlasCompactionObservation(
    2,
    relocations,
    Object.freeze({
      inputTiles: count,
      relocations: count,
      validNextHandles: count,
      invalidPreviousHandles: count
    })
  );
}

function atlasCompactionObservation(
  generation: number,
  relocations: readonly CanonicalAtlasCompaction['relocations'][number][],
  counters: CanonicalAtlasCompaction['counters']
): CanonicalAtlasCompaction {
  const frozenRelocations = Object.freeze([...relocations]);
  return Object.freeze({
    generation,
    relocations: frozenRelocations,
    counters,
    checksum: textChecksum(JSON.stringify({ generation, relocations: frozenRelocations, counters }))
  });
}

function assertAtlasScale(count: number, tileSize: number): void {
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new Error('Shadow atlas compaction count must be a positive integer.');
  }
  if (!Number.isSafeInteger(tileSize) || tileSize <= 0) {
    throw new Error('Shadow atlas compaction tileSize must be a positive integer.');
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function textChecksum(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function referenceSphereIntersects(
  center: readonly [number, number, number],
  radius: number,
  bounds: WorldBounds
): boolean {
  if (bounds.kind === 'sphere') {
    const x = center[0] - bounds.center[0];
    const y = center[1] - bounds.center[1];
    const z = center[2] - bounds.center[2];
    const combined = radius + bounds.radius;
    return x * x + y * y + z * z <= combined * combined;
  }
  let distanceSquared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const value = center[axis]!;
    const delta =
      value < bounds.min[axis]!
        ? bounds.min[axis]! - value
        : value > bounds.max[axis]!
          ? value - bounds.max[axis]!
          : 0;
    distanceSquared += delta * delta;
  }
  return distanceSquared <= radius * radius;
}

function randomPosition(random: () => number): readonly [number, number, number] {
  return [(random() - 0.5) * 60, (random() - 0.5) * 30, (random() - 0.5) * 60];
}

export interface ClusterWorkload {
  readonly view: Readonly<{
    readonly id: string;
    readonly layerMask: number;
    readonly inverseViewProjection: readonly number[];
    readonly near: number;
    readonly far: number;
    readonly width: number;
    readonly height: number;
    readonly tilesX: number;
    readonly tilesY: number;
    readonly sliceCount: number;
    readonly slicing: Readonly<{
      readonly depth: ClusterDepthPolicy;
      readonly shape: ClusterSliceShape;
      readonly lambda: number;
    }>;
  }>;
  readonly lights: readonly PreparedLight[];
  readonly capacity: ClusterCapacity;
}

export interface CanonicalClusterLists {
  readonly cacheIdentity: string;
  readonly clusterCount: number;
  readonly lightIndexCount: number;
  readonly overflowed: boolean;
  readonly directionalEntities: readonly RenderEntityId[];
  readonly clusters: readonly Readonly<{
    readonly cluster: number;
    readonly count: number;
    readonly overflowed: boolean;
    readonly lightEntities: readonly RenderEntityId[];
  }>[];
  readonly counters: Readonly<{
    readonly clusterCandidates: number;
    readonly intersectionTests: number;
    readonly emittedIndices: number;
    readonly overflowedClusters: number;
    readonly truncatedIndices: number;
  }>;
}

export function createClusterWorkload(
  tilesX: number,
  tilesY: number,
  sliceCount: number,
  lightCount: number,
  seed = 211,
  constrained = false
): ClusterWorkload {
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
  const aspect = tilesX / tilesY;
  const projection = Mat4.perspective(Math.PI / 4, aspect, 0.1, 100, STANDARD_DEPTH);
  const lights: PreparedLight[] = [];
  for (let index = 0; index < lightCount; index++) {
    const common = {
      entity: (lightCount - index) as RenderEntityId,
      payloadVersion: 1,
      colorLinear: [0.25 + random(), 0.25 + random(), 0.25 + random()] as const,
      enabled: index % 19 !== 0,
      layerMask: index % 17 === 0 ? 2 : 1,
      castsShadow: index % 3 === 0
    };
    if (index % 19 === 0) {
      lights.push({
        ...common,
        kind: 'directional',
        direction: [0.2, -1, -0.3],
        illuminanceLux: 50_000 + index
      });
    } else if (index % 3 === 0) {
      const position = randomClusterPosition(random);
      lights.push({
        ...common,
        kind: 'spot',
        position,
        direction: [0, 0, -1],
        luminousIntensityCandela: 500 + index,
        range: 3 + random() * 10,
        innerRadians: 0.14,
        outerRadians: 0.28
      });
    } else {
      const position = randomClusterPosition(random);
      lights.push({
        ...common,
        kind: 'point',
        position,
        luminousIntensityCandela: 500 + index,
        range: 2 + random() * 6
      });
    }
  }
  return Object.freeze({
    view: Object.freeze({
      id: `cluster-view-${tilesX}x${tilesY}-${sliceCount}`,
      layerMask: 1,
      inverseViewProjection: Object.freeze([...Mat4.invert(projection)]),
      near: 0.1,
      far: 100,
      width: 1920,
      height: Math.round(1920 / aspect),
      tilesX,
      tilesY,
      sliceCount,
      slicing: Object.freeze({ depth: 'infinite', shape: 'logarithmic', lambda: 0.5 })
    }),
    lights: Object.freeze(lights),
    capacity: Object.freeze(
      constrained
        ? {
            maxDirectionalLights: 1,
            maxLightsPerCluster: 4,
            maxClusterIndices: tilesX * tilesY * sliceCount * 2
          }
        : {
            maxDirectionalLights: lightCount,
            maxLightsPerCluster: lightCount,
            maxClusterIndices: tilesX * tilesY * sliceCount * lightCount
          }
    )
  });
}

export function runClusterSubject(workload: ClusterWorkload): CanonicalClusterLists {
  const grid = buildClusterGrid({
    viewId: workload.view.id,
    projectionRevision: 0,
    viewTransformRevision: 0,
    deviceGeneration: 0,
    viewport: { width: workload.view.width, height: workload.view.height },
    cameraNear: workload.view.near,
    cameraFar: workload.view.far,
    slicing: workload.view.slicing,
    sliceCount: workload.view.sliceCount,
    inverseViewProjection: workload.view.inverseViewProjection,
    tilesX: workload.view.tilesX,
    tilesY: workload.view.tilesY
  });
  const result = buildCpuClusters({
    viewId: workload.view.id,
    viewLayerMask: workload.view.layerMask,
    lights: workload.lights,
    grid,
    capacity: workload.capacity
  });
  return clusterObservation(result, grid, workload.view.layerMask, workload.lights);
}

/** Independent scalar oracle; re-sorts stable order and re-tests overlaps from scratch. */
export function runClusterReference(workload: ClusterWorkload): CanonicalClusterLists {
  const { tilesX, tilesY, sliceCount, near: cameraNear, far: cameraFar } = workload.view;
  const { width, height } = workload.view;
  const inverse = workload.view.inverseViewProjection;

  // Independent analytical computation of cluster depth slices and frustum AABBs
  const slices: { near: number; far: number }[] = [];
  let previous = cameraNear;
  for (let index = 0; index < sliceCount; index++) {
    const portion = (index + 1) / sliceCount;
    const remapped = index === sliceCount - 1 ? cameraFar : cameraNear / (1 - portion);
    const far = Math.min(remapped, cameraFar);
    slices.push({ near: previous, far });
    previous = far;
  }

  const tileWidth = width / tilesX;
  const tileHeight = height / tilesY;
  const clusterBoxes: {
    index: number;
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  }[] = [];
  let clusterIdx = 0;

  for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex++) {
    const slice = slices[sliceIndex]!;
    const nearT = (slice.near - cameraNear) / (cameraFar - cameraNear);
    const farT = (slice.far - cameraNear) / (cameraFar - cameraNear);

    for (let tileY = 0; tileY < tilesY; tileY++) {
      for (let tileX = 0; tileX < tilesX; tileX++) {
        const ndcX0 = ((tileX * tileWidth) / width) * 2 - 1;
        const ndcX1 = (((tileX + 1) * tileWidth) / width) * 2 - 1;
        const ndcY0 = ((tileY * tileHeight) / height) * 2 - 1;
        const ndcY1 = (((tileY + 1) * tileHeight) / height) * 2 - 1;

        const box = computeIndependentClusterAABB(inverse, ndcX0, ndcX1, ndcY0, ndcY1, nearT, farT);
        clusterBoxes.push({ index: clusterIdx++, min: box.min, max: box.max });
      }
    }
  }

  const cacheId = [
    workload.view.id,
    0, // projectionRevision
    0, // viewTransformRevision
    0, // deviceGeneration
    width,
    height,
    tilesX,
    tilesY,
    cameraNear,
    cameraFar,
    workload.view.slicing.depth,
    workload.view.slicing.shape,
    workload.view.slicing.lambda,
    sliceCount
  ].join('|');

  const ordered = [...workload.lights].sort((left, right) => left.entity - right.entity);
  const eligible = ordered.filter(
    (light) => light.enabled && (light.layerMask & workload.view.layerMask) !== 0
  );
  const directionalEntities: RenderEntityId[] = [];
  const local: Exclude<PreparedLight, { readonly kind: 'directional' }>[] = [];
  for (const light of eligible) {
    if (light.kind === 'directional') {
      if (directionalEntities.length < workload.capacity.maxDirectionalLights)
        directionalEntities.push(light.entity);
    } else {
      local.push(light);
    }
  }
  const clusters: {
    cluster: number;
    count: number;
    overflowed: boolean;
    lightEntities: RenderEntityId[];
  }[] = [];
  const indices: RenderEntityId[] = [];
  let clusterCandidates = 0;
  let intersectionTests = 0;
  let overflowedClusters = 0;
  let truncatedIndices = 0;
  for (const cluster of clusterBoxes) {
    const offset = indices.length;
    let count = 0;
    let overflowed = false;
    for (const light of local) {
      clusterCandidates++;
      intersectionTests++;
      if (!referenceInfluencesCluster(light, cluster.min, cluster.max)) continue;
      if (
        count >= workload.capacity.maxLightsPerCluster ||
        indices.length >= workload.capacity.maxClusterIndices
      ) {
        overflowed = true;
        truncatedIndices++;
        continue;
      }
      indices.push(light.entity);
      count++;
    }
    if (overflowed) overflowedClusters++;
    clusters.push({
      cluster: cluster.index,
      count,
      overflowed,
      lightEntities: indices.slice(offset, offset + count)
    });
  }
  return Object.freeze({
    cacheIdentity: cacheId,
    clusterCount: clusterBoxes.length,
    lightIndexCount: indices.length,
    overflowed: overflowedClusters > 0,
    directionalEntities: Object.freeze(directionalEntities),
    clusters: Object.freeze(
      clusters.map((cluster) =>
        Object.freeze({ ...cluster, lightEntities: Object.freeze(cluster.lightEntities) })
      )
    ),
    counters: Object.freeze({
      clusterCandidates,
      intersectionTests,
      emittedIndices: indices.length,
      overflowedClusters,
      truncatedIndices
    })
  });
}

function clusterObservation(
  result: ClusterBuildResult,
  grid: ClusterGrid,
  layerMask: number,
  lights: readonly PreparedLight[]
): CanonicalClusterLists {
  const maskFiltered = result.orderedLights.filter(
    (light) => light.enabled && (light.layerMask & layerMask) !== 0
  );
  const directionalEntities = Object.freeze(
    result.globalDirectionalLightIndices.map((index) => maskFiltered[index]!.entity)
  );
  const clusters = result.headers.map((header) =>
    Object.freeze({
      cluster: header.cluster,
      count: header.count,
      overflowed: header.overflowed,
      lightEntities: Object.freeze(
        result.lightIndices
          .slice(header.offset, header.offset + header.count)
          .map((index) => result.orderedLights[index]!.entity)
      )
    })
  );
  return Object.freeze({
    cacheIdentity: grid.cacheIdentity,
    clusterCount: grid.clusterCount,
    lightIndexCount: result.lightIndexCount,
    overflowed: result.overflowed,
    directionalEntities,
    clusters: Object.freeze(clusters),
    counters: Object.freeze({
      clusterCandidates: result.counters.clusterCandidates,
      intersectionTests: result.counters.intersectionTests,
      emittedIndices: result.counters.emittedIndices,
      overflowedClusters: result.counters.overflowedClusters,
      truncatedIndices: result.counters.truncatedIndices
    })
  });
}

function referenceInfluencesCluster(
  light: Exclude<PreparedLight, { readonly kind: 'directional' }>,
  min: readonly [number, number, number],
  max: readonly [number, number, number]
): boolean {
  if (light.kind === 'point') return referenceClusterSphere(light.position, light.range, min, max);
  return referenceClusterCone(
    light.position,
    light.direction,
    light.outerRadians,
    light.range,
    min,
    max
  );
}

function referenceClusterSphere(
  center: readonly [number, number, number],
  radius: number,
  min: readonly [number, number, number],
  max: readonly [number, number, number]
): boolean {
  let distanceSquared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const value = center[axis]!;
    const delta =
      value < min[axis]! ? min[axis]! - value : value > max[axis]! ? value - max[axis]! : 0;
    distanceSquared += delta * delta;
  }
  return distanceSquared <= radius * radius;
}

function referenceClusterCone(
  apex: readonly [number, number, number],
  axis: readonly [number, number, number],
  outerRadians: number,
  range: number,
  min: readonly [number, number, number],
  max: readonly [number, number, number]
): boolean {
  const length = Math.hypot(axis[0], axis[1], axis[2]);
  const nx = axis[0] / length;
  const ny = axis[1] / length;
  const nz = axis[2] / length;
  const planarityPoints = [
    min[0] * nx + min[1] * ny + min[2] * nz,
    min[0] * nx + min[1] * ny + max[2] * nz,
    min[0] * nx + max[1] * ny + min[2] * nz,
    min[0] * nx + max[1] * ny + max[2] * nz,
    max[0] * nx + min[1] * ny + min[2] * nz,
    max[0] * nx + min[1] * ny + max[2] * nz,
    max[0] * nx + max[1] * ny + min[2] * nz,
    max[0] * nx + max[1] * ny + max[2] * nz
  ];
  const apexProjection = apex[0] * nx + apex[1] * ny + apex[2] * nz;
  let minProjection = Infinity;
  let maxProjection = -Infinity;
  for (const value of planarityPoints) {
    if (value < minProjection) minProjection = value;
    if (value > maxProjection) maxProjection = value;
  }
  if (minProjection > apexProjection + range) return false;
  if (maxProjection < apexProjection) return false;

  let low = 0;
  let high = range;
  for (let iteration = 0; iteration < 64; iteration++) {
    const step = (high - low) / 3;
    const first = low + step;
    const second = high - step;
    const firstPoint = [apex[0] + nx * first, apex[1] + ny * first, apex[2] + nz * first] as const;
    const secondPoint = [
      apex[0] + nx * second,
      apex[1] + ny * second,
      apex[2] + nz * second
    ] as const;
    if (
      referenceClusterDistanceSquared(firstPoint, min, max) <=
      referenceClusterDistanceSquared(secondPoint, min, max)
    ) {
      high = second;
    } else {
      low = first;
    }
  }
  const t = (low + high) * 0.5;
  const axisPoint = [apex[0] + nx * t, apex[1] + ny * t, apex[2] + nz * t] as const;
  const distance = Math.sqrt(referenceClusterDistanceSquared(axisPoint, min, max));
  return distance <= t * Math.tan(outerRadians);
}

function referenceClusterDistanceSquared(
  point: readonly [number, number, number],
  min: readonly [number, number, number],
  max: readonly [number, number, number]
): number {
  let distanceSquared = 0;
  for (let axis = 0; axis < 3; axis++) {
    const delta =
      point[axis]! < min[axis]!
        ? min[axis]! - point[axis]!
        : point[axis]! > max[axis]!
          ? point[axis]! - max[axis]!
          : 0;
    distanceSquared += delta * delta;
  }
  return distanceSquared;
}

function randomClusterPosition(random: () => number): readonly [number, number, number] {
  const lateral = (random() - 0.5) * 4;
  const depth = 3 + random() * 40;
  return [lateral, lateral, -depth];
}

function computeIndependentClusterAABB(
  inverse: ArrayLike<number>,
  ndcX0: number,
  ndcX1: number,
  ndcY0: number,
  ndcY1: number,
  nearT: number,
  farT: number
): {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
} {
  const nearCorners = [
    unprojectFrustumCorner(inverse, ndcX0, ndcY0, 0),
    unprojectFrustumCorner(inverse, ndcX1, ndcY0, 0),
    unprojectFrustumCorner(inverse, ndcX1, ndcY1, 0),
    unprojectFrustumCorner(inverse, ndcX0, ndcY1, 0)
  ];
  const farCorners = [
    unprojectFrustumCorner(inverse, ndcX0, ndcY0, 1),
    unprojectFrustumCorner(inverse, ndcX1, ndcY0, 1),
    unprojectFrustumCorner(inverse, ndcX1, ndcY1, 1),
    unprojectFrustumCorner(inverse, ndcX0, ndcY1, 1)
  ];
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < 4; index++) {
    const near = [
      nearCorners[index]![0] + (farCorners[index]![0] - nearCorners[index]![0]) * nearT,
      nearCorners[index]![1] + (farCorners[index]![1] - nearCorners[index]![1]) * nearT,
      nearCorners[index]![2] + (farCorners[index]![2] - nearCorners[index]![2]) * nearT
    ];
    const far = [
      nearCorners[index]![0] + (farCorners[index]![0] - nearCorners[index]![0]) * farT,
      nearCorners[index]![1] + (farCorners[index]![1] - nearCorners[index]![1]) * farT,
      nearCorners[index]![2] + (farCorners[index]![2] - nearCorners[index]![2]) * farT
    ];
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, near[axis]!, far[axis]!);
      max[axis] = Math.max(max[axis]!, near[axis]!, far[axis]!);
    }
  }
  return { min, max };
}

function unprojectFrustumCorner(
  inverse: ArrayLike<number>,
  x: number,
  y: number,
  depth: number
): readonly [number, number, number] {
  const px = inverse[0]! * x + inverse[4]! * y + inverse[8]! * depth + inverse[12]!;
  const py = inverse[1]! * x + inverse[5]! * y + inverse[9]! * depth + inverse[13]!;
  const pz = inverse[2]! * x + inverse[6]! * y + inverse[10]! * depth + inverse[14]!;
  const pw = inverse[3]! * x + inverse[7]! * y + inverse[11]! * depth + inverse[15]!;
  return [px / pw, py / pw, pz / pw];
}
