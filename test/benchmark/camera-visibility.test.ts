import { describe, expect, test } from 'vitest';
import {
  createVisibilityCandidates,
  createSpatialEntries,
  prepareDynamicSpatialQuery,
  runSpatialSubject,
  runVisibilityReference,
  runVisibilitySubject
} from '../../benchmark/camera-visibility/scenario';

describe('camera visibility benchmark oracle', () => {
  test('generates deterministic workloads and agrees with the independent clip oracle', () => {
    for (const kind of ['sphere', 'aabb', 'mixed'] as const) {
      const candidates = createVisibilityCandidates(256, 23, kind);
      expect(createVisibilityCandidates(256, 23, kind)).toEqual(candidates);
      const subject = runVisibilitySubject(candidates);
      expect(subject.entities).toEqual(runVisibilityReference(candidates));
      expect(subject.counters).toMatchObject({
        candidates: 256,
        conservativeFallbackRetained: 0
      });
      expect(subject.counters.planeTests).toBeGreaterThan(subject.counters.retained);
    }
  });

  test('keeps the packed BVH subject exact with the current-entry linear oracle', () => {
    const entries = createSpatialEntries(1_000, 41, 'clustered', 0.01);
    const result = runSpatialSubject(entries);

    expect(result.entities).toEqual(result.referenceEntities);
    expect(result.counters.visitedNodes).toBeGreaterThan(0);
    expect(result.counters.indexedCandidates).toBeGreaterThan(0);
    expect(result.snapshot.nodeCount).toBeGreaterThan(1);
    expect(result.snapshot.checksum).toBeTypeOf('number');
  });

  test('keeps dynamic delta queries exact after the static snapshot is published', () => {
    const prepared = prepareDynamicSpatialQuery(createSpatialEntries(1_000, 43, 'clustered'), 0.1);
    const result = prepared.query();

    expect(result.entities).toEqual(prepared.referenceEntities);
    expect(result.counters.fallbackCandidates).toBe(100);
    expect(result.counters.staleIndexedSkipped).toBeGreaterThan(0);
  });
});
