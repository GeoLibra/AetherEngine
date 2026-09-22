import type { ClusterGrid } from '../types';

/** Fixed header followed by `(near, far)` IEEE-754 pairs for every depth slice. */
export const CLUSTER_FORWARD_HEADER_WORDS = 8;
export const CLUSTER_FORWARD_SLICE_WORDS = 2;
/** Fixed uniform capacity of the WebGPU clustered-forward fragment lookup. */
export const CLUSTER_FORWARD_MAX_SLICES = 64;
/** Fixed header-array capacity of the WebGPU clustered-forward fragment lookup. */
export const CLUSTER_FORWARD_MAX_CLUSTERS = 256;

/** Module-owned words consumed by the forward clustered-light fragment lookup. */
export interface PackedClusterForwardMetadata {
  readonly words: Uint32Array;
  readonly byteLength: number;
}

/**
 * Packs fragment lookup metadata separately from the cluster AABB compute input. Keeping this
 * compact ABI independent means a forward shader never has to parse conservative world bounds
 * merely to determine its tile and linear camera-depth slice.
 */
export function packClusterForwardMetadata(grid: ClusterGrid): PackedClusterForwardMetadata {
  if (grid.clusterCount > CLUSTER_FORWARD_MAX_CLUSTERS) {
    throw new Error(
      `Cluster forward metadata exceeds its shader maximum of ${CLUSTER_FORWARD_MAX_CLUSTERS} clusters.`
    );
  }
  if (grid.slices.length > CLUSTER_FORWARD_MAX_SLICES) {
    throw new Error(
      `Cluster forward metadata exceeds its shader maximum of ${CLUSTER_FORWARD_MAX_SLICES} depth slices.`
    );
  }
  const words = new Uint32Array(CLUSTER_FORWARD_HEADER_WORDS + grid.slices.length * 2);
  words[0] = grid.tilesX;
  words[1] = grid.tilesY;
  words[2] = grid.width;
  words[3] = grid.height;
  words[4] = grid.depth;
  words[5] = grid.slices.length;
  words[6] = grid.clusterCount;
  const float = new Float32Array(1);
  const bits = new Uint32Array(float.buffer);
  const writeDepth = (offset: number, value: number) => {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error('Cluster forward metadata slice depths must be positive finite values.');
    }
    float[0] = value;
    words[offset] = bits[0]!;
  };
  grid.slices.forEach(({ near, far }, index) => {
    const offset = CLUSTER_FORWARD_HEADER_WORDS + index * CLUSTER_FORWARD_SLICE_WORDS;
    writeDepth(offset, near);
    writeDepth(offset + 1, far);
  });
  return Object.freeze({ words, byteLength: words.byteLength });
}
