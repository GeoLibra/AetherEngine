import { bench, expect } from 'vitest';
import {
  createSpatialEntries,
  createVisibilityCandidates,
  createCameraSnapshotWorkload,
  buildSpatialSubject,
  prepareDynamicSpatialQuery,
  prepareSpatialQuery,
  runCameraSnapshotReference,
  runCameraSnapshotSubject,
  runVisibilitySubject
} from './camera-visibility/scenario';

for (const count of [100, 1_000, 10_000]) {
  const workload = createCameraSnapshotWorkload(count);
  const reference = runCameraSnapshotReference(workload);
  bench(
    `camera snapshot boundaries ${count} views`,
    () => expect(runCameraSnapshotSubject(workload)).toEqual(reference),
    { iterations: 1, warmupIterations: 0 }
  );
}

for (const boundsKind of ['sphere', 'aabb', 'mixed'] as const) {
  for (const count of [100, 1_000, 10_000]) {
    const candidates = createVisibilityCandidates(count, 17, boundsKind);
    bench(
      `CPU ${boundsKind} frustum scan ${count} candidates`,
      () => {
        const result = runVisibilitySubject(candidates);
        expect(result.counters.candidates).toBe(count);
        expect(result.counters.planeTests).toBeGreaterThan(0);
      },
      { iterations: 1, warmupIterations: 0 }
    );
  }
}

for (const distribution of ['uniform', 'clustered', 'collinear'] as const) {
  const entries = createSpatialEntries(10_000, 29, distribution);
  bench(
    `static BVH build ${distribution} 10000 entries`,
    () => {
      expect(buildSpatialSubject(entries).nodeCount).toBeGreaterThan(1);
    },
    { iterations: 1, warmupIterations: 0 }
  );

  const prepared = prepareSpatialQuery(entries);
  bench(
    `static BVH query ${distribution} 10000 entries`,
    () => {
      const result = prepared.query();
      expect(result.entities).toEqual(prepared.referenceEntities);
    },
    { iterations: 1, warmupIterations: 0 }
  );
}

const dynamicEntries = createSpatialEntries(10_000, 31, 'clustered');
const dynamic = prepareDynamicSpatialQuery(dynamicEntries, 0.01);
bench(
  'static BVH dynamic delta query 10000 entries 1% changed',
  () => {
    const result = dynamic.query();
    expect(result.entities).toEqual(dynamic.referenceEntities);
    expect(result.counters.fallbackCandidates).toBe(100);
  },
  { iterations: 1, warmupIterations: 0 }
);
