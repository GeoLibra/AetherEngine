import type { ClusterGrid } from '../types';
import { clusterIndexOf } from './cluster-grid';

/** Input fragment coordinates are viewport-local pixels with a positive camera-space depth. */
export interface ClusterFragmentPosition {
  readonly pixelX: number;
  readonly pixelY: number;
  readonly cameraDepth: number;
}

/**
 * Resolves the unique cluster owning a fragment. Right/bottom pixel edges and depths at a slice
 * far boundary belong to the next tile/slice; the final tile/slice remains inclusive at the
 * viewport/far edge. Returning `undefined` makes the forward caller select its explicit
 * unclustered fallback rather than indexing an unrelated storage header.
 */
export function selectClusterForFragment(
  grid: ClusterGrid,
  fragment: ClusterFragmentPosition
): number | undefined {
  const { pixelX, pixelY, cameraDepth } = fragment;
  if (![pixelX, pixelY, cameraDepth].every(Number.isFinite) || cameraDepth < grid.cameraNear) {
    return undefined;
  }
  if (pixelX < 0 || pixelY < 0 || pixelX >= grid.width || pixelY >= grid.height) return undefined;
  const tileX = Math.min(grid.tilesX - 1, Math.floor((pixelX * grid.tilesX) / grid.width));
  const tileY = Math.min(grid.tilesY - 1, Math.floor((pixelY * grid.tilesY) / grid.height));
  const slice = grid.slices.findIndex(
    ({ near, far }, index) =>
      cameraDepth >= near &&
      (cameraDepth < far || (index === grid.slices.length - 1 && cameraDepth <= far))
  );
  return slice < 0 ? undefined : clusterIndexOf(grid, tileX, tileY, slice);
}
