import {
  ShadowAtlasAllocator,
  buildCpuLightLists,
  selectShadowRequests,
  type CpuLightListCapacity,
  type LightReceiver,
  type PreparedLight,
  type RenderEntityId,
  type ShadowBudget,
  type ShadowRequest,
  type WorldBounds
} from '../../src/rendering';

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
