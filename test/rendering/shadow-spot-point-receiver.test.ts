import { describe, expect, test } from 'vitest';
import type { PreparedLight } from '../../src/rendering';
import {
  buildPointShadowFaceViewProjection,
  buildSpotShadowViewProjection,
  pointShadowFaceIndexAndUv,
  projectPointToShadowSpace,
  sampleShadowDepthMapPcf
} from '../../src/rendering';
import { buildCpuClusters, buildClusterGrid, coneIntersectsAABB } from '../../src/rendering';
import { Mat4 } from '../../src/math';
import { STANDARD_DEPTH } from '../../src/math/depth';

const VIEW_MASK = 0x1;

function cameraInverseViewProjection(): Float32Array {
  // Camera at the origin looking down +Z, so world-space clusters sit at positive Z.
  const view = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, -1, 0, 0, 0, 0, 1]);
  const projection = Mat4.perspective(Math.PI / 4, 1, 0.1, 100, STANDARD_DEPTH);
  return Mat4.invert(Mat4.multiply(projection, view));
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
    return {
      ...common,
      kind,
      position: overrides.position ?? [0, 0, 5],
      luminousIntensityCandela: 100,
      range: overrides.range ?? 2
    } as unknown as PreparedLight;
  }
  return {
    ...common,
    kind,
    position: overrides.position ?? [0, 0, 5],
    direction: overrides.direction ?? [0, 0, 1],
    luminousIntensityCandela: 100,
    range: overrides.range ?? 2,
    innerRadians: 0.1,
    outerRadians: 0.5
  } as unknown as PreparedLight;
}

describe('spot shadow view-projection oracle', () => {
  test('projects the cone axis center to the shadow-map center', () => {
    const vp = buildSpotShadowViewProjection({
      position: [0, 0, 0],
      direction: [0, 0, 1],
      range: 10,
      outerRadians: Math.PI / 6
    });
    const sample = projectPointToShadowSpace(vp, [0, 0, 5]);
    expect(sample).toBeDefined();
    expect(sample!.uv[0]).toBeCloseTo(0.5, 6);
    expect(sample!.uv[1]).toBeCloseTo(0.5, 6);
    expect(sample!.depth).toBeGreaterThan(0);
    expect(sample!.depth).toBeLessThan(1);
  });

  test('off-axis points land inside the cone and far outside is rejected', () => {
    const vp = buildSpotShadowViewProjection({
      position: [0, 0, 0],
      direction: [0, 0, 1],
      range: 10,
      outerRadians: Math.PI / 6
    });
    const inside = projectPointToShadowSpace(vp, [0, 2, 5]);
    expect(inside).toBeDefined();
    expect(inside!.uv[1]).toBeCloseTo(0.5, 6);
    expect(inside!.uv[0]).not.toBeCloseTo(0.5, 1);
    expect(projectPointToShadowSpace(vp, [0, 6, 5])).toBeUndefined();
    expect(projectPointToShadowSpace(vp, [6, 0, 5])).toBeUndefined();
  });

  test('points just before the far plane map to depth close to one', () => {
    const vp = buildSpotShadowViewProjection({
      position: [0, 0, 0],
      direction: [0, 0, 1],
      range: 10,
      outerRadians: Math.PI / 6
    });
    const sample = projectPointToShadowSpace(vp, [0, 0, 9.99]);
    expect(sample).toBeDefined();
    expect(sample!.depth).toBeGreaterThan(0.99);
  });

  test('the spot view-projection is invertible', () => {
    const vp = buildSpotShadowViewProjection({
      position: [1, 2, 3],
      direction: [-0.5, 1, 0.2],
      range: 10,
      outerRadians: Math.PI / 6
    });
    const roundTrip = Mat4.invert(vp);
    const point = Mat4.transformPoint(roundTrip, [0, 0, -2.5]);
    expect(Number.isFinite(point[0])).toBe(true);
    expect(point.some(Number.isNaN)).toBe(false);
  });

  test('rejects degenerate spot projections', () => {
    expect(() =>
      buildSpotShadowViewProjection({
        position: [0, 0, 0],
        direction: [0, 0, 0],
        range: 10,
        outerRadians: Math.PI / 6
      })
    ).toThrow(/non-zero/);
    expect(() =>
      buildSpotShadowViewProjection({
        position: [0, 0, 0],
        direction: [0, 0, 1],
        range: -1,
        outerRadians: Math.PI / 6
      })
    ).toThrow(/range/);
  });
});

describe('spot shadow PCF oracle', () => {
  const depthMap = new Float32Array(16).fill(0.5);
  depthMap[5] = 0.4;

  test('returns one for a fully visible receiver', () => {
    expect(
      sampleShadowDepthMapPcf({
        uv: [0.5, 0.5],
        depth: 0.3,
        depthMap,
        width: 4,
        height: 4,
        constantBias: 0.001,
        slopeBias: 0.01,
        normalDotLight: 1
      })
    ).toBe(1);
  });

  test('returns zero when every 3x3 tap is occluding', () => {
    const occluding = new Float32Array(16).fill(0.1);
    expect(
      sampleShadowDepthMapPcf({
        uv: [0.5, 0.5],
        depth: 0.5,
        depthMap: occluding,
        width: 4,
        height: 4,
        constantBias: 0.001,
        slopeBias: 0.01,
        normalDotLight: 0
      })
    ).toBe(0);
  });

  test('single-tap sampling matches the center texel visibility only', () => {
    const visibility = sampleShadowDepthMapPcf({
      uv: [0.5, 0.5],
      depth: 0.6,
      depthMap,
      width: 4,
      height: 4,
      constantBias: 0,
      slopeBias: 0,
      normalDotLight: 1,
      tapCount: 1
    });
    expect(visibility).toBe(0);
  });
});

describe('point shadow face selection oracle', () => {
  test('selects the correct face and uv center for dominant axis directions', () => {
    expect(pointShadowFaceIndexAndUv([1, 0, 0])).toMatchObject({ face: 0, uv: [0.5, 0.5] });
    expect(pointShadowFaceIndexAndUv([-1, 0, 0])).toMatchObject({ face: 1, uv: [0.5, 0.5] });
    expect(pointShadowFaceIndexAndUv([0, 1, 0])).toMatchObject({ face: 2, uv: [0.5, 0.5] });
    expect(pointShadowFaceIndexAndUv([0, -1, 0])).toMatchObject({ face: 3, uv: [0.5, 0.5] });
    expect(pointShadowFaceIndexAndUv([0, 0, 1])).toMatchObject({ face: 4, uv: [0.5, 0.5] });
    expect(pointShadowFaceIndexAndUv([0, 0, -1])).toMatchObject({ face: 5, uv: [0.5, 0.5] });
  });

  test('produces uv within the [0, 1] square for an arbitrary direction', () => {
    const result = pointShadowFaceIndexAndUv([0.3, -0.8, 0.5]);
    expect(result.face).toBeGreaterThanOrEqual(0);
    expect(result.face).toBeLessThanOrEqual(5);
    expect(result.uv[0]).toBeGreaterThanOrEqual(0);
    expect(result.uv[0]).toBeLessThanOrEqual(1);
    expect(result.uv[1]).toBeGreaterThanOrEqual(0);
    expect(result.uv[1]).toBeLessThanOrEqual(1);
  });

  test('rejects a zero direction', () => {
    expect(() => pointShadowFaceIndexAndUv([0, 0, 0])).toThrow(/non-zero/);
  });

  test('each face projection maps its forward direction to the shadow-map center', () => {
    const faces = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1]
    ];
    faces.forEach((forward, face) => {
      const vp = buildPointShadowFaceViewProjection({
        position: [0, 0, 0],
        face,
        near: 0.01,
        far: 10
      });
      const sample = projectPointToShadowSpace(vp, forward as [number, number, number]);
      expect(sample).toBeDefined();
      expect(sample!.uv[0]).toBeCloseTo(0.5, 5);
      expect(sample!.uv[1]).toBeCloseTo(0.5, 5);
    });
  });
});

describe('spot lights reuse the CPU cone test in cluster builds', () => {
  test('a spot light whose cone covers a cluster is assigned to it', () => {
    const grid = buildClusterGrid({
      viewId: 'view-spot-assign',
      projectionRevision: 1,
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
    const centerCluster = grid.clusters.find((cluster) => {
      return pointInside(cluster, [0, 0, 5]);
    });
    expect(centerCluster).toBeDefined();
    expect(
      coneIntersectsAABB({
        apex: [0, 0, 0],
        axis: [0, 0, 1],
        outerRadians: Math.PI / 6,
        range: 10,
        bounds: centerCluster!
      })
    ).toBe(true);

    const result = buildCpuClusters({
      viewId: 'view-spot-assign',
      viewLayerMask: VIEW_MASK,
      lights: [light(7, 'spot', { position: [0, 0, 0], direction: [0, 0, 1], range: 10 })],
      grid,
      capacity: {
        maxDirectionalLights: 64,
        maxLightsPerCluster: 8,
        maxClusterIndices: 4096
      }
    });
    const assignedClusters = result.headers
      .filter((header) => header.count > 0)
      .map((header) => header.cluster);
    expect(assignedClusters).toContain(centerCluster!.index);
  });
});

function pointInside(
  cluster: {
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
  },
  point: readonly [number, number, number]
): boolean {
  return (
    point[0] >= cluster.min[0] &&
    point[0] <= cluster.max[0] &&
    point[1] >= cluster.min[1] &&
    point[1] <= cluster.max[1] &&
    point[2] >= cluster.min[2] &&
    point[2] <= cluster.max[2]
  );
}
