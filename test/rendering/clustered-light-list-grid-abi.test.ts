import { expect, test } from 'vitest';
import {
  LIGHT_LIST_HEADER_WORDS,
  LIGHT_LIST_LIGHT_WORDS,
  packClusterGridForWebGpu,
  packWebGpuClusterLights,
  packWebGpuLightListInput,
  decodeWebGpuClusterLightListOutput,
  type ClusterGrid
} from '../../src/rendering';

test('packs cluster AABB records into a stable WebGPU storage ABI', () => {
  const grid = {
    clusterCount: 1,
    tilesX: 2,
    tilesY: 3,
    depth: 4,
    clusters: [{ index: 0, tileX: 1, tileY: 2, slice: 3, min: [-1, 2, 3], max: [4, 5, 6] }]
  } as unknown as ClusterGrid;
  const packed = packClusterGridForWebGpu(grid, {
    maxDirectionalLights: 3,
    maxLightsPerCluster: 5,
    maxClusterIndices: 7
  });
  expect([...packed.words.slice(0, 8)]).toEqual([1, 2, 3, 4, 3, 5, 7, 0]);
  expect([...packed.words.slice(8, 12)]).toEqual([0, 1, 2, 3]);
  expect([...new Float32Array(packed.words.buffer, 12 * 4, 6)]).toEqual([-1, 2, 3, 4, 5, 6]);
});

test('packs shared forward records while retaining spot axes and cone angles for GPU cluster culling', () => {
  const spot = {
    kind: 'spot' as const,
    entity: 9 as never,
    payloadVersion: 1,
    colorLinear: [1, 1, 1] as const,
    enabled: true,
    layerMask: 1,
    castsShadow: true,
    position: [2, 3, 4] as const,
    direction: [0, 0, -1] as const,
    luminousIntensityCandela: 10,
    range: 20,
    innerRadians: 0.2,
    outerRadians: 0.4
  };
  const packed = packWebGpuClusterLights({
    viewLayerMask: 1,
    lights: [spot]
  });
  expect([...packed.words.slice(0, 4)]).toEqual([1, 1, 0, 0]);
  expect([...packed.words.slice(4, 8)]).toEqual([2, 3, 1, 9]);
  const floats = new Float32Array(packed.words.buffer, 8 * 4, 12);
  expect([...floats.slice(0, 8)]).toEqual([2, 3, 4, 20, 1, 1, 1, 10]);
  expect([...floats.slice(8, 11)]).toEqual([0, 0, -1]);
  expect(floats[11]).toBeCloseTo(0.4, 6);
  const receiverPacked = packWebGpuLightListInput({
    viewLayerMask: 1,
    lights: [spot],
    receivers: [],
    capacity: { maxLightsPerReceiver: 1, maxDirectionalLights: 1, maxLightIndices: 1 }
  });
  expect([...packed.words.slice(4, 4 + LIGHT_LIST_LIGHT_WORDS)]).toEqual([
    ...receiverPacked.lights.slice(
      LIGHT_LIST_HEADER_WORDS,
      LIGHT_LIST_HEADER_WORDS + LIGHT_LIST_LIGHT_WORDS
    )
  ]);
});

test('decodes cluster headers without leaking receiver terminology into the cluster API', () => {
  const decoded = decodeWebGpuClusterLightListOutput({
    directionalIndices: new Uint32Array([7]),
    headers: new Uint32Array([3, 0, 2, 1]),
    lightIndices: new Uint32Array([4, 5]),
    overflow: new Uint32Array([0x4000_0001, 1, 2, 0])
  });
  expect(decoded).toEqual({
    directionalIndices: [7],
    headers: [{ cluster: 3, offset: 0, count: 2, overflowed: true }],
    lightIndices: [4, 5],
    overflowed: true
  });
});
