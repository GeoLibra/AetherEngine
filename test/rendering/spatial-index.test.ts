import { describe, expect, test } from 'vitest';
import { Frustum, Mat4 } from '../../src/math';
import {
  StaticBvhSpatialIndex,
  buildPackedStaticBvh,
  type RenderEntityId,
  type SpatialEntry
} from '../../src/rendering';

const entity = (value: number) => value as RenderEntityId;
const entry = (id: number, x: number, revision = 1, insertionOrder = id): SpatialEntry => ({
  renderEntity: entity(id),
  boundsRevision: revision,
  bounds: { kind: 'sphere', center: [x, 0, -2], radius: 0.25 },
  layerMask: 1,
  enabled: true,
  insertionOrder
});
const view = {
  id: 'main',
  camera: entity(99),
  surface: 'headless',
  viewport: { x: 0, y: 0, width: 100, height: 100 },
  layerMask: 1,
  featurePolicyKey: 'static-bvh-delta@1',
  historyKey: 'main',
  frustum: Frustum.fromViewProjection(Mat4.perspective(Math.PI / 2, 1, 0.1, 10))
};

describe('packed static BVH', () => {
  test('classifies packed scalar AABB bounds without changing frustum semantics', () => {
    const frustum = Frustum.fromViewProjection(Mat4.perspective(Math.PI / 2, 1, 0.1, 10));

    expect(frustum.classifyAabbValues(-1, -1, -3, 1, 1, -1)).toEqual(
      frustum.classifyAabb([-1, -1, -3], [1, 1, -1])
    );
    expect(() => frustum.classifyAabbValues(1, 0, -1, -1, 1, 0)).toThrow(/AABB/i);
  });

  test('reproduces its packed checksum independent of input order', () => {
    const first = buildPackedStaticBvh([entry(3, 0), entry(1, -1), entry(2, 1)]);
    const second = buildPackedStaticBvh([entry(2, 1), entry(3, 0), entry(1, -1)]);

    expect(first.checksum).toBe(second.checksum);
    expect([...first.entityIds]).toEqual([...second.entityIds]);
    expect(first.nodeCount).toBeGreaterThan(0);
  });
});

describe('static BVH plus delta spatial index', () => {
  test('keeps pending entries on the current linear lane until an atomic publish', () => {
    const index = new StaticBvhSpatialIndex({ leafSize: 1 });
    const entries = [entry(2, 0), entry(1, 20)];
    index.queueDesired(entries, 7);

    const partial = index.applyBudget({ maxDesiredEntries: 2, maxBuildOperations: 1 });
    expect(partial.rebuildState).toBe('building');
    expect(index.snapshot().rootNode).toBeNull();
    const pendingQuery = index.query(view, entries);
    expect(pendingQuery.entities).toEqual([entity(2)]);
    expect(pendingQuery.counters.fallbackCandidates).toBe(2);

    let result = partial;
    while (result.rebuildState === 'building') {
      result = index.applyBudget({ maxDesiredEntries: 2, maxBuildOperations: 2 });
    }
    expect(result.rebuildState).toBe('ready-to-publish');
    expect(index.snapshot().rootNode).toBeNull();
    index.publishReady();
    expect(index.snapshot().rootNode).toBe(0);
    expect(index.query(view, entries).entities).toEqual([entity(2)]);
  });

  test('skips stale indexed payload and uses the latest fallback bounds', () => {
    const index = new StaticBvhSpatialIndex({ leafSize: 1 });
    const original = [entry(1, 0.5, 1)];
    index.queueDesired(original, 1);
    index.applyBudget({ maxDesiredEntries: 1, maxBuildOperations: 100 });
    index.publishReady();

    const moved = [entry(1, 0, 2)];
    index.queueDesired(moved, 2);
    const result = index.query(view, moved);

    expect(result.entities).toEqual([entity(1)]);
    expect(result.counters.staleIndexedSkipped).toBe(1);
    expect(result.counters.fallbackCandidates).toBe(1);
  });

  test('deduplicates active and fallback lanes and sorts by entity then insertion order', () => {
    const index = new StaticBvhSpatialIndex({ leafSize: 1 });
    const current = [entry(4, 0, 1, 9), entry(2, 0, 1, 20), entry(3, 0, 1, 1)];
    index.queueDesired(current, 1);
    index.applyBudget({ maxDesiredEntries: 3, maxBuildOperations: 100 });
    index.publishReady();
    index.queueDesired([entry(2, 0, 2, 20), entry(3, 0, 1, 1), entry(4, 0, 1, 9)], 2);

    const result = index.query(view, [entry(2, 0, 2, 20), entry(3, 0, 1, 1), entry(4, 0, 1, 9)]);

    expect(result.entities).toEqual([entity(2), entity(3), entity(4)]);
    expect(new Set(result.entities).size).toBe(3);
  });

  test('tombstones removed entries instead of returning stale entities', () => {
    const index = new StaticBvhSpatialIndex();
    index.queueDesired([entry(1, 0), entry(2, 0)], 1);
    index.applyBudget({ maxDesiredEntries: 2, maxBuildOperations: 100 });
    index.publishReady();
    index.queueDesired([entry(2, 0)], 2);

    expect(index.query(view, [entry(2, 0)]).entities).toEqual([entity(2)]);
  });
});
