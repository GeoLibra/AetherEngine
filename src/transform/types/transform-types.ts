import type { Entity } from '../../ecs/types';
import type { Quaternion, Vec3 } from '../../math/types';

/**
 * Initial input properties for creating or attaching a local transform component.
 */
export interface LocalTransformInput {
  /** Local translation vector [x, y, z]. Defaults to [0, 0, 0]. */
  readonly translation?: Vec3;
  /** Local rotation quaternion [x, y, z, w]. Defaults to identity [0, 0, 0, 1]. */
  readonly rotation?: Quaternion;
  /** Local scale factors [sx, sy, sz]. Defaults to [1, 1, 1]. */
  readonly scale?: Vec3;
}

/**
 * Partial update descriptor for modifying an existing entity's local transform.
 */
export interface LocalTransformPatch extends LocalTransformInput {
  /**
   * If true, forces dirty-marking and matrix recalculation even if values
   * are within floating-point epsilon comparison threshold.
   */
  readonly forceDirty?: boolean;
}

/**
 * Strategy applied when changing an entity's parent in the transform hierarchy.
 * - `keep-local`: Preserves the local TRS values (entity moves relative to new parent).
 * - `keep-world`: Adjusts local TRS to preserve the current world-space visual transform.
 */
export type ReparentMode = 'keep-local' | 'keep-world';

/**
 * Policy governing how child entities are handled when their parent is despawned.
 * - `cascade`: Recursively despawns all descendants in the subtree.
 * - `detach-keep-world`: Detaches children to the root level while preserving world positions.
 * - `reject-if-children`: Throws an error if the entity has any active children.
 */
export type ParentDespawnPolicy = 'cascade' | 'detach-keep-world' | 'reject-if-children';

/**
 * Diagnostic statistics collected during transform hierarchy matrix propagation.
 */
export interface TransformPropagationStats {
  /** Number of independent dirty subtree roots processed. */
  readonly dirtyRoots: number;
  /** Total number of entities whose world transforms were recalculated. */
  readonly propagated: number;
  /** Maximum hierarchy depth traversed during propagation. */
  readonly maxDepth: number;
}

/**
 * Configuration options for initializing the TransformRuntime.
 */
export interface TransformRuntimeOptions {
  /** Size of each coordinate grid cell in world units for floating origin. Defaults to 1000. */
  readonly cellSize?: number;
}

/**
 * Represents a large-world coordinate decomposed into grid cell and sub-cell offset
 * to preserve 32-bit floating point precision across unbounded distances.
 */
export interface WorldPosition {
  /** Integer grid cell indices [cx, cy, cz]. */
  readonly cell: Vec3;
  /** Sub-cell continuous offset vector [ox, oy, oz] relative to cell center. */
  readonly offset: Vec3;
}

/**
 * Categorized reason for resetting transform history matrices (disables temporal interpolation).
 */
export type HistoryResetReason = 'teleport' | 'origin-rebase' | 'camera-cut' | 'scene-load';

/**
 * Options supplied when extracting render-ready transform matrices.
 */
export interface TransformExtractOptions {
  /** Normalized sub-frame interpolation factor [0, 1] between previous and current matrices. */
  readonly interpolationAlpha: number;
  /** Optional camera position in world space for camera-relative rendering translation. */
  readonly camera?: WorldPosition;
}

/**
 * Immutable snapshot of an entity's interpolated transform, prepared for the renderer.
 */
export interface RenderTransformSnapshot {
  /** The associated entity ID. */
  readonly entity: Entity;
  /** Interpolated 4x4 model-to-world (or camera-relative) matrix. */
  readonly matrix: readonly number[];
  /** Previous frame 4x4 matrix for motion vector generation and temporal AA. */
  readonly previousMatrix: readonly number[];
  /** 3x3 normal transformation matrix (inverse-transpose of upper-left 3x3). */
  readonly normalMatrix: readonly number[];
  /** Sign of matrix determinant (+1 or -1) to detect negative scale/mirroring for winding order. */
  readonly determinantSign: number;
  /** Monotonically increasing version counter for cache validation. */
  readonly worldVersion: number;
}

/**
 * Direct typed-array view into the ECS LocalTransform component storage.
 */
export interface LocalTransformView {
  /** Translation vector [x, y, z]. */
  translation: Float32Array;
  /** Rotation quaternion [x, y, z, w]. */
  rotation: Float32Array;
  /** Scale factors [sx, sy, sz]. */
  scale: Float32Array;
  /** Version counter incremented on every local mutation. */
  localVersion: number;
}

/**
 * Direct typed-array view into the ECS WorldTransform component storage.
 */
export interface WorldTransformView {
  /** Current 4x4 world transformation matrix. */
  matrix: Float32Array;
  /** Previous frame 4x4 world transformation matrix. */
  previousMatrix: Float32Array;
  /** 3x3 normal matrix for lighting and normal mapping. */
  normalMatrix: Float32Array;
  /** Version counter incremented on matrix recomputation. */
  worldVersion: number;
  /** Current world grid cell reference. */
  originCell: Int32Array;
  /** Sign of determinant (+1 or -1) for front-face culling determination. */
  determinantSign: number;
}
