import { expect, test } from 'vitest';
import {
  buildClusterGrid,
  CLUSTER_FORWARD_HEADER_WORDS,
  CLUSTER_FORWARD_MAX_CLUSTERS,
  packClusterForwardMetadata,
  selectClusterForFragment
} from '../../src';

test('selects a stable viewport tile and depth slice with explicit outer-edge rules', () => {
  const grid = buildClusterGrid({
    viewId: 'main',
    projectionRevision: 1,
    viewTransformRevision: 1,
    deviceGeneration: 1,
    viewport: { width: 100, height: 80 },
    cameraNear: 1,
    cameraFar: 9,
    slicing: { depth: 'finite', shape: 'uniform', lambda: 0 },
    sliceCount: 2,
    inverseViewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    tilesX: 2,
    tilesY: 2
  });

  expect(selectClusterForFragment(grid, { pixelX: 0, pixelY: 0, cameraDepth: 1 })).toBe(0);
  expect(selectClusterForFragment(grid, { pixelX: 50, pixelY: 40, cameraDepth: 5 })).toBe(7);
  expect(selectClusterForFragment(grid, { pixelX: 99, pixelY: 79, cameraDepth: 9 })).toBe(7);
  expect(
    selectClusterForFragment(grid, { pixelX: 100, pixelY: 0, cameraDepth: 1 })
  ).toBeUndefined();
  expect(
    selectClusterForFragment(grid, { pixelX: 0, pixelY: 0, cameraDepth: 9.01 })
  ).toBeUndefined();
});

test('packs viewport and slice boundaries for the forward cluster lookup ABI', () => {
  const grid = buildClusterGrid({
    viewId: 'main',
    projectionRevision: 1,
    viewTransformRevision: 1,
    deviceGeneration: 1,
    viewport: { width: 100, height: 80 },
    cameraNear: 1,
    cameraFar: 9,
    slicing: { depth: 'finite', shape: 'uniform', lambda: 0 },
    sliceCount: 2,
    inverseViewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    tilesX: 2,
    tilesY: 2
  });
  const packed = packClusterForwardMetadata(grid);
  const floats = new Float32Array(packed.words.buffer);

  expect([...packed.words.slice(0, CLUSTER_FORWARD_HEADER_WORDS)]).toEqual([
    2, 2, 100, 80, 2, 2, 8, 0
  ]);
  expect([...floats.slice(CLUSTER_FORWARD_HEADER_WORDS)]).toEqual([1, 5, 5, 9]);
});

test('rejects a grid exceeding the fixed fragment header capacity', () => {
  const grid = buildClusterGrid({
    viewId: 'oversized',
    projectionRevision: 1,
    viewTransformRevision: 1,
    deviceGeneration: 1,
    viewport: { width: 272, height: 1 },
    cameraNear: 1,
    cameraFar: 2,
    slicing: { depth: 'finite', shape: 'uniform', lambda: 0 },
    sliceCount: 1,
    inverseViewProjection: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
    tilesX: 17,
    tilesY: 16
  });
  expect(grid.clusterCount).toBe(CLUSTER_FORWARD_MAX_CLUSTERS + 16);
  expect(() => packClusterForwardMetadata(grid)).toThrow('exceeds its shader maximum');
});
