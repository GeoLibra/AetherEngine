import { describe, expect, test } from 'vitest';
import { Mat4 } from '../../src/math';
import { STANDARD_DEPTH } from '../../src/math/depth';
import type {
  ClusterBuildResult,
  ClusterGrid,
  LightReceiver,
  PreparedLight,
  RenderEntityId
} from '../../src/rendering';
import {
  buildCpuClusters,
  buildClusterGrid,
  buildCpuLightLists,
  decodeWebGlLightListOutput,
  decodeWebGpuLightListOutput,
  packCpuClusterListForWebGl,
  packCpuClusterListForWebGpu,
  packWebGlLightListInput,
  packWebGpuLightListInput
} from '../../src/rendering';

const VIEW_MASK = 0x1;

function cameraInverseViewProjection(): Float32Array {
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
    entity: entity as RenderEntityId,
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
    innerRadians: Math.PI / 12,
    outerRadians: Math.PI / 6
  } as unknown as PreparedLight;
}

function sampleGrid(): ClusterGrid {
  return buildClusterGrid({
    viewId: 'view-abi',
    projectionRevision: 2,
    viewTransformRevision: 0,
    deviceGeneration: 0,
    viewport: { width: 320, height: 240 },
    cameraNear: 0.1,
    cameraFar: 10,
    slicing: { depth: 'infinite', shape: 'logarithmic', lambda: 0.6 },
    sliceCount: 3,
    inverseViewProjection: cameraInverseViewProjection(),
    tilesX: 3,
    tilesY: 2
  });
}

describe('CPU cluster build ABI round-trip and equivalence', () => {
  const lights: PreparedLight[] = [
    light(1, 'directional'),
    light(2, 'point', { position: [0, 0, 5], range: 4 }),
    light(3, 'spot', { position: [0, 0, 5], direction: [0, 0, 1], range: 4 }),
    light(4, 'point', { position: [-100, 0, 5], range: 1 })
  ];

  const capacity = {
    maxDirectionalLights: 64,
    maxLightsPerCluster: 8,
    maxClusterIndices: 4096
  };

  test('decoded WebGPU output matches the CPU cluster reference exactly', () => {
    const grid = sampleGrid();
    const result = buildCpuClusters({
      viewId: 'view-abi',
      viewLayerMask: VIEW_MASK,
      lights,
      grid,
      capacity
    });

    const packed = packCpuClusterListForWebGpu(
      { viewLayerMask: VIEW_MASK, lights },
      capacity,
      result
    );

    const decoded = decodeWebGpuLightListOutput({
      directionalIndices: packed.directionalWords,
      headers: packed.headerWords,
      lightIndices: packed.indexWords,
      overflow: packed.overflowWords
    });

    expect(decoded.overflowed).toBe(false);
    expect(decoded.directionalIndices).toEqual(result.globalDirectionalLightIndices);
    expect(decoded.headers).toHaveLength(result.headers.length);
    decoded.headers.forEach((header, index) => {
      const expected = result.headers[index]!;
      expect(header.receiver).toBe(expected.cluster);
      expect(header.offset).toBe(expected.offset);
      expect(header.count).toBe(expected.count);
      expect(header.overflowed).toBe(expected.overflowed);
    });
    expect(decoded.lightIndices).toEqual(result.lightIndices);
  });

  test('decoded WebGL2 output matches the CPU cluster reference exactly', () => {
    const grid = sampleGrid();
    const result = buildCpuClusters({
      viewId: 'view-abi',
      viewLayerMask: VIEW_MASK,
      lights,
      grid,
      capacity
    });

    const packed = packCpuClusterListForWebGl(
      { viewLayerMask: VIEW_MASK, lights },
      capacity,
      4096,
      result
    );

    const decoded = decodeWebGlLightListOutput({
      receiverCount: result.headers.length,
      capacity: {
        maxDirectionalLights: capacity.maxDirectionalLights,
        maxLightsPerReceiver: capacity.maxLightsPerCluster,
        maxLightIndices: capacity.maxClusterIndices
      },
      width: packed.width,
      directional: packed.directionalTexels,
      headers: packed.headerTexels,
      indices: packed.indexTexels,
      overflow: packed.overflowTexels
    });

    expect(decoded.overflowed).toBe(false);
    expect(decoded.directionalIndices).toEqual(result.globalDirectionalLightIndices);
    expect(decoded.headers).toHaveLength(result.headers.length);
    decoded.headers.forEach((header, index) => {
      const expected = result.headers[index]!;
      expect(header.receiver).toBe(expected.cluster);
      expect(header.offset).toBe(expected.offset);
      expect(header.count).toBe(expected.count);
      expect(header.overflowed).toBe(expected.overflowed);
    });
    expect(decoded.lightIndices).toEqual(result.lightIndices);
  });

  test('cluster grid AABBs converted to LightReceivers match CPU cluster culling for point lights', () => {
    const grid = sampleGrid();
    const pointLights: PreparedLight[] = [
      light(10, 'directional'),
      light(20, 'point', { position: [0, 0, 5], range: 3 }),
      light(30, 'point', { position: [-100, 0, 5], range: 1 })
    ];

    const clusterReceivers: LightReceiver[] = grid.clusters.map((c) => ({
      renderEntity: c.index as RenderEntityId,
      layerMask: VIEW_MASK,
      bounds: { kind: 'aabb' as const, min: c.min, max: c.max }
    }));

    const cpuCapacity = {
      maxDirectionalLights: 64,
      maxLightsPerReceiver: 8,
      maxLightIndices: 4096
    };

    const boundedResult = buildCpuLightLists({
      viewLayerMask: VIEW_MASK,
      lights: pointLights,
      receivers: clusterReceivers,
      capacity: cpuCapacity
    });

    const clusterResult = buildCpuClusters({
      viewId: 'view-abi',
      viewLayerMask: VIEW_MASK,
      lights: pointLights,
      grid,
      capacity: {
        maxDirectionalLights: cpuCapacity.maxDirectionalLights,
        maxLightsPerCluster: cpuCapacity.maxLightsPerReceiver,
        maxClusterIndices: cpuCapacity.maxLightIndices
      }
    });

    expect(boundedResult.globalDirectionalLightIndices).toEqual(
      clusterResult.globalDirectionalLightIndices
    );
    expect(boundedResult.headers.length).toBe(clusterResult.headers.length);
    boundedResult.headers.forEach((h, index) => {
      const ch = clusterResult.headers[index]!;
      expect(h.receiver).toBe(ch.cluster);
      expect(h.count).toBe(ch.count);
      expect(h.overflowed).toBe(ch.overflowed);
    });
    expect(boundedResult.lightIndices).toEqual(clusterResult.lightIndices);

    const gpuPacked = packWebGpuLightListInput({
      viewLayerMask: VIEW_MASK,
      lights: pointLights,
      receivers: clusterReceivers,
      capacity: cpuCapacity
    });
    expect(gpuPacked.receivers[0]).toBe(clusterReceivers.length);

    const glPacked = packWebGlLightListInput({
      viewLayerMask: VIEW_MASK,
      lights: pointLights,
      receivers: clusterReceivers,
      capacity: cpuCapacity,
      maxTextureDimension2D: 4096
    });
    expect(glPacked.receivers.length).toBeGreaterThan(0);
  });

  test('packCpuClusterListForWebGpu throws fail-fast when cluster count exceeds maximum receivers', () => {
    const fakeHeaders = Array.from({ length: 257 }, (_, i) => ({
      cluster: i,
      offset: 0,
      count: 0,
      overflowed: false
    }));
    const fakeResult = {
      viewId: 'fake-view',
      source: 'cpu-upload' as const,
      clusterCount: 257,
      capacity: { maxDirectionalLights: 16, maxLightsPerCluster: 4, maxClusterIndices: 256 },
      fallback: 'none' as const,
      orderedLights: [],
      globalDirectionalLightIndices: [],
      headers: fakeHeaders,
      lightIndices: [],
      lightIndexCount: 0,
      overflowed: false,
      counters: {
        inputLights: 0,
        disabledLights: 0,
        layerRejectedLights: 0,
        clusterCandidates: 0,
        intersectionTests: 0,
        directionalCount: 0,
        directionalTruncated: 0,
        emittedIndices: 0,
        overflowedClusters: 0,
        truncatedIndices: 0
      }
    } satisfies ClusterBuildResult;
    expect(() =>
      packCpuClusterListForWebGpu(
        { viewLayerMask: VIEW_MASK, lights: [] },
        { maxDirectionalLights: 16, maxLightsPerCluster: 4, maxClusterIndices: 256 },
        fakeResult
      )
    ).toThrow(/exceeds WebGPU light list shader maximum receivers/);
  });

  test('packCpuClusterListForWebGpu throws fail-fast when index count exceeds maximum indices', () => {
    const fakeIndices = new Array(4097).fill(0);
    const fakeResult = {
      viewId: 'fake-view',
      source: 'cpu-upload' as const,
      clusterCount: 1,
      capacity: { maxDirectionalLights: 16, maxLightsPerCluster: 4097, maxClusterIndices: 4096 },
      fallback: 'deterministic-truncate' as const,
      orderedLights: [],
      globalDirectionalLightIndices: [],
      headers: [{ cluster: 0, offset: 0, count: 4097, overflowed: true }],
      lightIndices: fakeIndices,
      lightIndexCount: 4097,
      overflowed: true,
      counters: {
        inputLights: 0,
        disabledLights: 0,
        layerRejectedLights: 0,
        clusterCandidates: 0,
        intersectionTests: 0,
        directionalCount: 0,
        directionalTruncated: 0,
        emittedIndices: 4097,
        overflowedClusters: 1,
        truncatedIndices: 0
      }
    } satisfies ClusterBuildResult;
    expect(() =>
      packCpuClusterListForWebGpu(
        { viewLayerMask: VIEW_MASK, lights: [] },
        { maxDirectionalLights: 16, maxLightsPerCluster: 4097, maxClusterIndices: 4096 },
        fakeResult
      )
    ).toThrow(/exceeds WebGPU light list shader maximum indices/);
  });
});
