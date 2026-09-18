import { describe, expect, test } from 'vitest';
import { Mat4 } from '../../src/math';
import { STANDARD_DEPTH } from '../../src/math/depth';
import type { ClusterAABB, ClusterGrid, PreparedLight } from '../../src/rendering';
import {
  buildCpuClusters,
  buildClusterGrid,
  clusterIndexOf,
  computeClusterDepthSlices,
  coneIntersectsAABB,
  sphereIntersectsAABB
} from '../../src/rendering';

const VIEW_MASK = 0x1;

function cameraInverseViewProjection(): Float32Array {
  // Camera at the origin looking down +Z, so world-space clusters sit at positive Z.
  const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
  const projection = Mat4.perspective(Math.PI / 4, 1, 0.1, 100, STANDARD_DEPTH);
  return Mat4.invert(Mat4.multiply(projection, view));
}

function aabb(
  min: readonly [number, number, number],
  max: readonly [number, number, number],
  index = 0
): ClusterAABB {
  return Object.freeze({
    index,
    tileX: index % 4,
    tileY: Math.floor(index / 4) % 4,
    slice: Math.floor(index / 16),
    min: Object.freeze([...min]) as ClusterAABB['min'],
    max: Object.freeze([...max]) as ClusterAABB['max']
  });
}

function sampleGrid(overrides: Partial<Parameters<typeof buildClusterGrid>[0]> = {}): ClusterGrid {
  return buildClusterGrid({
    viewId: 'view-main',
    projectionRevision: 3,
    viewTransformRevision: 0,
    deviceGeneration: 1,
    viewport: { width: 800, height: 600 },
    cameraNear: 0.1,
    cameraFar: 100,
    slicing: { depth: 'finite', shape: 'logarithmic', lambda: 0.6 },
    sliceCount: 4,
    inverseViewProjection: cameraInverseViewProjection(),
    tilesX: 4,
    tilesY: 4,
    ...overrides
  });
}

function light(
  entity: number,
  kind: PreparedLight['kind'],
  overrides: Record<string, unknown> = {}
): PreparedLight {
  const common = {
    entity,
    payloadVersion: 1,
    colorLinear: [1, 1, 1] as const,
    enabled: true,
    layerMask: VIEW_MASK,
    castsShadow: false,
    ...overrides
  };
  if (kind === 'directional') {
    return {
      ...common,
      kind,
      direction: [0, 0, 1],
      illuminanceLux: 1000
    } as unknown as PreparedLight;
  }
  if (kind === 'point') {
    const position = (overrides.position ?? [0, 0, 5]) as readonly number[];
    return {
      ...common,
      kind,
      position,
      luminousIntensityCandela: 100,
      range: (overrides.range ?? 2) as number
    } as unknown as PreparedLight;
  }
  const position = (overrides.position ?? [0, 0, 5]) as readonly number[];
  return {
    ...common,
    kind,
    position,
    direction: (overrides.direction ?? [0, 0, 1]) as readonly number[],
    luminousIntensityCandela: 100,
    range: (overrides.range ?? 2) as number,
    innerRadians: 0.1,
    outerRadians: 0.5
  } as unknown as PreparedLight;
}

describe('cluster depth slicing', () => {
  test('finite uniform slices split near-to-far into equal camera-depth intervals', () => {
    const slices = computeClusterDepthSlices({
      near: 1,
      far: 9,
      sliceCount: 4,
      policy: 'finite',
      shape: 'uniform',
      lambda: 1
    });
    expect(slices.map((slice) => [slice.near, slice.far])).toEqual([
      [1, 3],
      [3, 5],
      [5, 7],
      [7, 9]
    ]);
    expect(slices.map((slice) => slice.index)).toEqual([0, 1, 2, 3]);
  });

  test('infinite policy places slices near-dense through the stable depth remap', () => {
    const slices = computeClusterDepthSlices({
      near: 1,
      far: 100,
      sliceCount: 4,
      policy: 'infinite',
      shape: 'logarithmic',
      lambda: 1
    });
    expect(slices).toHaveLength(4);
    expect(slices[0]!.near).toBe(1);
    expect(slices[3]!.far).toBe(100);
    for (let index = 0; index < slices.length; index++) {
      const slice = slices[index]!;
      expect(slice.far).toBeGreaterThan(slice.near);
      if (index > 0) expect(slice.near).toBe(slices[index - 1]!.far);
    }
    const gaps = slices.map((slice) => slice.far - slice.near);
    expect(gaps[0]!).toBeLessThan(gaps[1]!);
    expect(gaps[1]!).toBeLessThan(gaps[2]!);
  });

  test('rejects degenerate slice inputs', () => {
    expect(() =>
      computeClusterDepthSlices({
        near: 1,
        far: 1,
        sliceCount: 4,
        policy: 'finite',
        shape: 'uniform',
        lambda: 0.5
      })
    ).toThrow(/greater than near/);
    expect(() =>
      computeClusterDepthSlices({
        near: 0.1,
        far: 100,
        sliceCount: 0,
        policy: 'finite',
        shape: 'uniform',
        lambda: 0.5
      })
    ).toThrow(/positive integer/);
  });
});

describe('cluster grid', () => {
  test('builds one AABB per cell with the documented index layout', () => {
    const grid = sampleGrid();
    expect(grid.clusterCount).toBe(4 * 4 * 4);
    expect(grid.depth).toBe(4);
    expect(clusterIndexOf(grid, 0, 0, 0)).toBe(0);
    expect(clusterIndexOf(grid, 3, 3, 3)).toBe(63);
    for (const cluster of grid.clusters) {
      expect(cluster.index).toBe(
        (cluster.slice * grid.tilesY + cluster.tileY) * grid.tilesX + cluster.tileX
      );
      expect(cluster.min[0]).toBeLessThanOrEqual(cluster.max[0]);
      expect(cluster.min[1]).toBeLessThanOrEqual(cluster.max[1]);
      expect(cluster.min[2]).toBeLessThanOrEqual(cluster.max[2]);
      expect(cluster.min.every(Number.isFinite)).toBe(true);
      expect(cluster.max.every(Number.isFinite)).toBe(true);
    }
  });

  test('first slice hugs the camera near plane and z grows with the slice index', () => {
    const grid = sampleGrid();
    const nearSlice = grid.clusters.filter((cluster) => cluster.slice === 0);
    const farSlice = grid.clusters.filter((cluster) => cluster.slice === grid.depth - 1);
    for (const cluster of nearSlice) {
      expect(cluster.min[2]).toBeGreaterThanOrEqual(grid.cameraNear);
      expect(cluster.max[2]).toBeLessThanOrEqual(grid.slices[0]!.far + 1e-9);
    }
    const nearFarthest = Math.max(...nearSlice.map((cluster) => cluster.max[2]));
    const farClosest = Math.min(...farSlice.map((cluster) => cluster.min[2]));
    expect(farClosest).toBeGreaterThanOrEqual(nearFarthest - 1e-6);
  });

  test('cache identity changes with projection revision, view transform revision, tiles, or device generation', () => {
    const base = sampleGrid();
    const same = sampleGrid();
    expect(same.cacheIdentity).toBe(base.cacheIdentity);

    const revision = sampleGrid({ projectionRevision: 9 });
    expect(revision.cacheIdentity).not.toBe(base.cacheIdentity);

    const viewTransform = sampleGrid({ viewTransformRevision: 4 });
    expect(viewTransform.cacheIdentity).not.toBe(base.cacheIdentity);

    const tiles = sampleGrid({ tilesX: 8 });
    expect(tiles.cacheIdentity).not.toBe(base.cacheIdentity);

    const device = sampleGrid({ deviceGeneration: 2 });
    expect(device.cacheIdentity).not.toBe(base.cacheIdentity);
  });
});

describe('cluster intersection reference tests', () => {
  const bounds = aabb([0.1, 0.1, 4.9], [0.2, 0.2, 5.1]);

  test('sphere test accepts inside and rejects outside AABBs', () => {
    expect(sphereIntersectsAABB([0.1, 0.15, 5], 1, bounds)).toBe(true);
    expect(sphereIntersectsAABB([0.4, 0.15, 5], 0.01, bounds)).toBe(false);
    expect(sphereIntersectsAABB([100, 100, 100], 0.5, bounds)).toBe(false);
  });

  test('cone test accepts on-axis boxes and rejects lateral, far-cap, and behind-apex boxes', () => {
    const cone = {
      apex: [0, 0, 0] as const,
      axis: [0, 0, 1] as const,
      outerRadians: Math.PI / 6,
      range: 10
    };
    expect(coneIntersectsAABB({ ...cone, bounds })).toBe(true);
    expect(coneIntersectsAABB({ ...cone, bounds: aabb([6, -0.1, 4.9], [6.1, 0.1, 5.1]) })).toBe(
      false
    );
    expect(coneIntersectsAABB({ ...cone, bounds: aabb([0, 0, 11], [0.1, 0.1, 12]) })).toBe(false);
    expect(coneIntersectsAABB({ ...cone, bounds: aabb([0, 0, -3], [0.1, 0.1, -2]) })).toBe(false);
  });
});

describe('CPU cluster light-list reference', () => {
  function grid(lightsPerCluster = 8): ClusterGrid {
    return buildClusterGrid({
      viewId: 'view-cluster',
      projectionRevision: 1,
      viewTransformRevision: 0,
      deviceGeneration: 0,
      viewport: { width: 320, height: 240 },
      cameraNear: 0.1,
      cameraFar: 10,
      slicing: { depth: 'finite', shape: 'uniform', lambda: 0 },
      sliceCount: 2,
      inverseViewProjection: cameraInverseViewProjection(),
      tilesX: 2,
      tilesY: 2
    });
  }

  test('collects directional lights globally and assigns local lights by cluster', () => {
    const lights: PreparedLight[] = [
      light(1, 'directional'),
      light(2, 'point', { position: [0, 0, 5], range: 3 }),
      light(3, 'spot', { position: [100, 100, 100], direction: [0, 0, 1], range: 1 }),
      light(4, 'point', { position: [100, 100, 100], range: 1 })
    ];
    const result = buildCpuClusters({
      viewId: 'view-cluster',
      viewLayerMask: VIEW_MASK,
      lights,
      grid: grid(),
      capacity: {
        maxDirectionalLights: 64,
        maxLightsPerCluster: 8,
        maxClusterIndices: 4096
      }
    });
    expect(result.source).toBe('cpu-upload');
    expect(result.overflowed).toBe(false);
    expect(result.fallback).toBe('none');
    expect(result.globalDirectionalLightIndices).toEqual([0]);
    expect(result.orderedLights.map((value) => value.entity)).toEqual([1, 2, 3, 4]);
    const assigned = new Set(result.lightIndices);
    expect(assigned.has(1)).toBe(true);
    expect(assigned.has(2)).toBe(false);
    expect(assigned.has(3)).toBe(false);
    const totalIndexCount = result.headers.reduce((sum, header) => sum + header.count, 0);
    expect(totalIndexCount).toBe(result.lightIndexCount);
  });

  test('truncates per cluster in stable entity order and marks overflow deterministically', () => {
    // Two lights influence the center cluster but only one slot is allowed.
    const lights: PreparedLight[] = [
      light(10, 'point', { position: [0, 0, 5], range: 2 }),
      light(11, 'point', { position: [0.05, 0, 5], range: 2 })
    ];
    const result = buildCpuClusters({
      viewId: 'view-cluster',
      viewLayerMask: VIEW_MASK,
      lights,
      grid: grid(),
      capacity: {
        maxDirectionalLights: 64,
        maxLightsPerCluster: 1,
        maxClusterIndices: 4096
      }
    });
    expect(result.overflowed).toBe(true);
    expect(result.fallback).toBe('deterministic-truncate');
    const affected = result.headers.filter((header) => header.count > 0 || header.overflowed);
    expect(affected.length).toBeGreaterThan(0);
    for (const header of affected) {
      expect(header.overflowed).toBe(true);
      expect(header.count).toBe(1);
      expect(result.lightIndices.slice(header.offset, header.offset + header.count)).toEqual([0]);
    }
    expect(result.counters.truncatedIndices).toBeGreaterThan(0);
  });

  test('global index truncation stops appends once the shared index pool is full', () => {
    const lights: PreparedLight[] = [
      light(20, 'point', { position: [0, 0, 5], range: 3 }),
      light(21, 'point', { position: [0.1, 0, 5], range: 3 })
    ];
    const result = buildCpuClusters({
      viewId: 'view-cluster',
      viewLayerMask: VIEW_MASK,
      lights,
      grid: grid(),
      capacity: {
        maxDirectionalLights: 64,
        maxLightsPerCluster: 8,
        maxClusterIndices: 1
      }
    });
    expect(result.overflowed).toBe(true);
    expect(result.lightIndexCount).toBe(1);
  });

  test('excluded lights never appear in any cluster list', () => {
    const lights: PreparedLight[] = [
      light(1, 'point', { position: [0, 0, 5], range: 2 }),
      light(2, 'point', { position: [0, 0, 5], range: 2, enabled: false }),
      light(3, 'point', { position: [100, 0, 5], range: 2 })
    ];
    const result = buildCpuClusters({
      viewId: 'view-cluster',
      viewLayerMask: VIEW_MASK,
      lights,
      grid: grid(),
      capacity: {
        maxDirectionalLights: 64,
        maxLightsPerCluster: 8,
        maxClusterIndices: 4096
      }
    });
    const assigned = new Set(result.lightIndices);
    expect(assigned.has(0)).toBe(true);
    expect(assigned.has(1)).toBe(false);
    expect(assigned.has(2)).toBe(false);
    expect(result.counters.disabledLights).toBe(1);
  });
});
