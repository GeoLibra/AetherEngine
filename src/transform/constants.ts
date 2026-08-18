/**
 * Transform Subsystem Constants: Observer identifiers, tolerance thresholds, and default grid settings.
 */

/**
 * Standard observer identifiers registered by the TransformRuntime to track hierarchy and component changes.
 */
export const TRANSFORM_OBSERVERS = {
  LocalAdded: 'aether.transform.local-added',
  ParentAdded: 'aether.transform.parent-added',
  ParentRemoved: 'aether.transform.parent-removed'
} as const;

export type TransformObserverId = (typeof TRANSFORM_OBSERVERS)[keyof typeof TRANSFORM_OBSERVERS];

/**
 * Default floating-origin grid cell size in world units.
 */
export const DEFAULT_CELL_SIZE = 1_000;

/**
 * Floating-point comparison tolerance epsilon used for transform equality detection.
 */
export const TRANSFORM_EPSILON = 1e-6;
