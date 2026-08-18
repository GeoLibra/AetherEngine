/**
 * Transform Subsystem: Local/World coordinate spaces, hierarchical propagation,
 * floating origin large-world coordinates, and temporal interpolation.
 */

export {
  DEFAULT_CELL_SIZE,
  TRANSFORM_EPSILON,
  TRANSFORM_OBSERVERS,
  type TransformObserverId
} from './constants';
export { LocalTransform, WorldTransform } from './components';
export { TransformHistory, TransformHistoryResource } from './history';
export {
  normalizeWorldPosition,
  worldPositionRelativeToOrigin,
  WorldOrigin,
  WorldOriginResource
} from './position';
export { TransformRuntime, TransformRuntimeResource } from './runtime';
export type {
  HistoryResetReason,
  LocalTransformInput,
  LocalTransformPatch,
  LocalTransformView,
  ParentDespawnPolicy,
  ReparentMode,
  RenderTransformSnapshot,
  TransformExtractOptions,
  TransformPropagationStats,
  TransformRuntimeOptions,
  WorldPosition,
  WorldTransformView
} from './types';
