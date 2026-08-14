import { Frustum, Mat4 } from '../../src/math';
import {
  computeVisibility,
  buildPackedStaticBvh,
  conservativeSphereFromScale,
  createCpuVisibilityView,
  extractView,
  linearCullSpatialEntries,
  StaticBvhSpatialIndex,
  type RenderEntityId,
  type SpatialEntry,
  type VisibilityCandidate
} from '../../src/rendering';

export interface CameraSnapshotWorkload {
  readonly entries: readonly Readonly<{
    center: readonly [number, number, number];
    localRadius: number;
    scale: readonly [number, number, number];
    jitterPixels: readonly [number, number];
    logicalWidth: number;
  }>[];
}

export interface CameraSnapshotResult {
  readonly count: number;
  readonly checksum: number;
}

export function createCameraSnapshotWorkload(count: number, seed = 53): CameraSnapshotWorkload {
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
  return Object.freeze({
    entries: Object.freeze(
      Array.from({ length: count }, (_, index) =>
        Object.freeze({
          center: [random() * 20 - 10, random() * 10 - 5, -random() * 50] as const,
          localRadius: 0.25 + random() * 2,
          scale: [random() * 3 - 1.5, random() * 3 - 1.5, random() * 3 - 1.5] as const,
          jitterPixels: [(index % 3) - 1, (index % 5) - 2] as const,
          logicalWidth: 320 + (index % 7) * 16
        })
      )
    )
  });
}

export function runCameraSnapshotSubject(workload: CameraSnapshotWorkload): CameraSnapshotResult {
  let checksum = 0;
  for (let index = 0; index < workload.entries.length; index++) {
    const entry = workload.entries[index]!;
    const sphere = conservativeSphereFromScale(entry.center, entry.localRadius, entry.scale);
    const extracted = extractView({
      viewId: `snapshot-${index}`,
      camera: index as RenderEntityId,
      revision: index,
      view: Mat4.identity(),
      projection: Mat4.identity(),
      unjitteredProjection: Mat4.identity(),
      projectionDescriptor: {
        kind: 'orthographic',
        near: 0.1,
        far: 100,
        orthographicHalfHeight: 1
      },
      viewport: { logicalWidth: entry.logicalWidth, logicalHeight: 180, devicePixelRatio: 2 },
      layerMask: 1,
      jitterPixels: entry.jitterPixels
    });
    const visibility = createCpuVisibilityView(extracted, {
      surface: 'benchmark',
      featurePolicyKey: 'snapshot-boundary',
      historyKey: `snapshot-${index}`
    });
    checksum +=
      sphere.center[0] +
      sphere.radius +
      extracted.jitterPixels[0] +
      visibility.viewport.width +
      visibility.viewMatrix![0]!;
  }
  return Object.freeze({ count: workload.entries.length, checksum });
}

/** Independent scalar oracle for camera snapshot boundaries. */
export function runCameraSnapshotReference(workload: CameraSnapshotWorkload): CameraSnapshotResult {
  let checksum = 0;
  for (const entry of workload.entries) {
    const radius =
      entry.localRadius *
      Math.max(Math.abs(entry.scale[0]), Math.abs(entry.scale[1]), Math.abs(entry.scale[2]));
    checksum += entry.center[0] + radius + entry.jitterPixels[0] + entry.logicalWidth * 2 + 1;
  }
  return Object.freeze({ count: workload.entries.length, checksum });
}

export function createVisibilityCandidates(
  count: number,
  seed = 17,
  boundsKind: 'sphere' | 'aabb' | 'mixed' = 'sphere'
): readonly VisibilityCandidate[] {
  let state = seed >>> 0;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 0x1_0000_0000;
  return Object.freeze(
    Array.from({ length: count }, (_, index) => {
      const center = [(random() - 0.5) * 30, (random() - 0.5) * 20, -random() * 40 - 0.1] as const;
      const radius = 0.05 + random();
      const useAabb = boundsKind === 'aabb' || (boundsKind === 'mixed' && index % 2 === 1);
      return Object.freeze({
        entity: index as RenderEntityId,
        layerMask: index % 7 === 0 ? 2 : 1,
        bounds: useAabb
          ? {
              kind: 'aabb' as const,
              min: [center[0] - radius, center[1] - radius, center[2] - radius] as const,
              max: [center[0] + radius, center[1] + radius, center[2] + radius] as const
            }
          : { kind: 'sphere' as const, center, radius }
      });
    })
  );
}

export function createSpatialEntries(
  count: number,
  seed = 17,
  distribution: 'uniform' | 'clustered' | 'collinear' = 'uniform',
  dynamicRatio = 0
): readonly SpatialEntry[] {
  const candidates = createVisibilityCandidates(count, seed, 'mixed');
  return Object.freeze(
    candidates.map((candidate, index) => {
      const source = candidate.bounds!;
      const center =
        source.kind === 'sphere'
          ? source.center
          : ([
              (source.min[0] + source.max[0]) * 0.5,
              (source.min[1] + source.max[1]) * 0.5,
              (source.min[2] + source.max[2]) * 0.5
            ] as const);
      const radius =
        source.kind === 'sphere' ? source.radius : (source.max[0] - source.min[0]) * 0.5;
      const placed =
        distribution === 'clustered'
          ? ([center[0] * 0.15, center[1] * 0.15, -8 + center[2] * 0.05] as const)
          : distribution === 'collinear'
            ? ([index * 0.02 - count * 0.01, 0, -8] as const)
            : center;
      return Object.freeze({
        renderEntity: candidate.entity,
        boundsRevision: index < Math.floor(count * dynamicRatio) ? 2 : 1,
        bounds:
          index % 2 === 0
            ? { kind: 'sphere' as const, center: placed, radius }
            : {
                kind: 'aabb' as const,
                min: [placed[0] - radius, placed[1] - radius, placed[2] - radius] as const,
                max: [placed[0] + radius, placed[1] + radius, placed[2] + radius] as const
              },
        layerMask: candidate.layerMask,
        enabled: true,
        insertionOrder: index
      });
    })
  );
}

export function runSpatialSubject(entries: readonly SpatialEntry[]) {
  const prepared = prepareSpatialQuery(entries);
  const result = prepared.query();
  return Object.freeze({
    ...result,
    referenceEntities: prepared.referenceEntities,
    snapshot: prepared.snapshot
  });
}

export function buildSpatialSubject(entries: readonly SpatialEntry[]) {
  return buildPackedStaticBvh(entries, { leafSize: 8, maxDepth: 32 });
}

export function prepareSpatialQuery(entries: readonly SpatialEntry[]) {
  const view = createBenchmarkView();
  const index = publishSpatialIndex(entries);
  const reference = linearCullSpatialEntries(view, entries);
  return Object.freeze({
    query: () => index.query(view, entries),
    referenceEntities: Object.freeze(reference.map((entry) => entry.renderEntity)),
    snapshot: index.snapshot()
  });
}

export function prepareDynamicSpatialQuery(entries: readonly SpatialEntry[], dynamicRatio: number) {
  const view = createBenchmarkView();
  const index = publishSpatialIndex(entries);
  const dynamicCount = Math.floor(entries.length * dynamicRatio);
  const current = entries.map((entry, position) =>
    position < dynamicCount
      ? Object.freeze({
          ...entry,
          boundsRevision: entry.boundsRevision + 1,
          bounds: moveBounds(entry.bounds, 0.125)
        })
      : entry
  );
  index.queueDesired(current, 2);
  const reference = linearCullSpatialEntries(view, current);
  return Object.freeze({
    query: () => index.query(view, current),
    referenceEntities: Object.freeze(reference.map((entry) => entry.renderEntity))
  });
}

function publishSpatialIndex(entries: readonly SpatialEntry[]): StaticBvhSpatialIndex {
  const index = new StaticBvhSpatialIndex({ leafSize: 8, maxDepth: 32 });
  index.queueDesired(entries, 1);
  index.applyBudget({
    maxDesiredEntries: entries.length,
    maxBuildOperations: Number.MAX_SAFE_INTEGER
  });
  index.publishReady();
  return index;
}

function moveBounds(bounds: SpatialEntry['bounds'], offset: number): SpatialEntry['bounds'] {
  return bounds.kind === 'sphere'
    ? {
        kind: 'sphere',
        center: [bounds.center[0] + offset, bounds.center[1], bounds.center[2]],
        radius: bounds.radius
      }
    : {
        kind: 'aabb',
        min: [bounds.min[0] + offset, bounds.min[1], bounds.min[2]],
        max: [bounds.max[0] + offset, bounds.max[1], bounds.max[2]]
      };
}

function createBenchmarkView() {
  return {
    id: 'bench',
    camera: 0 as RenderEntityId,
    surface: 'headless',
    viewport: { x: 0, y: 0, width: 1920, height: 1080 },
    layerMask: 1,
    featurePolicyKey: 'static-bvh-delta@1',
    historyKey: 'bench',
    frustum: Frustum.fromViewProjection(Mat4.perspective(Math.PI / 2, 16 / 9, 0.1, 50))
  };
}

export function runVisibilitySubject(candidates: readonly VisibilityCandidate[]) {
  const frustum = Frustum.fromViewProjection(Mat4.perspective(Math.PI / 2, 16 / 9, 0.1, 50));
  return computeVisibility(
    {
      id: 'bench',
      camera: 0 as RenderEntityId,
      surface: 'headless',
      viewport: { x: 0, y: 0, width: 1920, height: 1080 },
      layerMask: 1,
      featurePolicyKey: 'cpu',
      historyKey: 'bench',
      frustum
    },
    candidates
  );
}

export function runVisibilityReference(
  candidates: readonly VisibilityCandidate[]
): readonly RenderEntityId[] {
  const matrix = Mat4.perspective(Math.PI / 2, 16 / 9, 0.1, 50);
  const row = (index: number) =>
    [matrix[index]!, matrix[index + 4]!, matrix[index + 8]!, matrix[index + 12]!] as const;
  const combine = (left: readonly number[], right: readonly number[], sign = 1) =>
    left.map((value, index) => value + sign * right[index]!) as number[];
  const row0 = row(0),
    row1 = row(1),
    row2 = row(2),
    row3 = row(3);
  const planes = [
    combine(row3, row0),
    combine(row3, row0, -1),
    combine(row3, row1),
    combine(row3, row1, -1),
    [...row2],
    combine(row3, row2, -1)
  ];
  return Object.freeze(
    candidates
      .filter((candidate) => candidate.layerMask === 1)
      .filter((candidate) => {
        const bounds = candidate.bounds!;
        return planes.every((plane) => {
          if (bounds.kind === 'sphere') {
            const [x, y, z] = bounds.center;
            return (
              plane[0]! * x + plane[1]! * y + plane[2]! * z + plane[3]! >=
              -bounds.radius * Math.hypot(plane[0]!, plane[1]!, plane[2]!)
            );
          }
          const x = plane[0]! >= 0 ? bounds.max[0] : bounds.min[0];
          const y = plane[1]! >= 0 ? bounds.max[1] : bounds.min[1];
          const z = plane[2]! >= 0 ? bounds.max[2] : bounds.min[2];
          return plane[0]! * x + plane[1]! * y + plane[2]! * z + plane[3]! >= 0;
        });
      })
      .map((candidate) => candidate.entity)
      .sort((a, b) => a - b)
  );
}
