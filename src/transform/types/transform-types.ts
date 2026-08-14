import type { Entity } from '../../ecs/types';
import type { Quaternion, Vec3 } from '../../math/types';

export interface LocalTransformInput {
  readonly translation?: Vec3;
  readonly rotation?: Quaternion;
  readonly scale?: Vec3;
}

export interface LocalTransformPatch extends LocalTransformInput {
  readonly forceDirty?: boolean;
}

export type ReparentMode = 'keep-local' | 'keep-world';
export type ParentDespawnPolicy = 'cascade' | 'detach-keep-world' | 'reject-if-children';

export interface TransformPropagationStats {
  readonly dirtyRoots: number;
  readonly propagated: number;
  readonly maxDepth: number;
}

export interface TransformRuntimeOptions {
  readonly cellSize?: number;
}

export interface WorldPosition {
  readonly cell: Vec3;
  readonly offset: Vec3;
}

export type HistoryResetReason = 'teleport' | 'origin-rebase' | 'camera-cut' | 'scene-load';

export interface TransformExtractOptions {
  readonly interpolationAlpha: number;
  readonly camera?: WorldPosition;
}

export interface RenderTransformSnapshot {
  readonly entity: Entity;
  readonly matrix: Float32Array;
  readonly previousMatrix: Float32Array;
  readonly normalMatrix: Float32Array;
  readonly determinantSign: number;
  readonly worldVersion: number;
}

export interface LocalTransformView {
  translation: Float32Array;
  rotation: Float32Array;
  scale: Float32Array;
  localVersion: number;
}

export interface WorldTransformView {
  matrix: Float32Array;
  previousMatrix: Float32Array;
  normalMatrix: Float32Array;
  worldVersion: number;
  originCell: Int32Array;
  determinantSign: number;
}
