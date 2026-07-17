import type { RenderEntityId } from './render-world';

/**
 * Encapsulates the visible boundary of an entity for frustum culling.
 */
export interface VisibilityCandidate {
  readonly entity: RenderEntityId;
  readonly layerMask: number; // Bitwise mask of layers this entity belongs to
  readonly center: readonly [number, number, number]; // Sphere center point
  readonly radius: number; // Sphere radius bounding the entity geometry
}

/**
 * Represents a viewport view context (e.g. camera, shadow map cascade).
 */
export interface RenderView {
  readonly id: string;
  readonly camera: RenderEntityId;
  readonly surface: string;
  readonly viewport: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly layerMask: number; // Bitwise mask of visible layers for this camera
  readonly featurePolicyKey: string;
  readonly historyKey: string;
  // Dynamic frustum bounding sphere intersection check callback.
  readonly containsSphere: (center: readonly [number, number, number], radius: number) => boolean;
}

export interface ViewVisibilitySnapshot {
  readonly viewId: string;
  readonly entities: readonly RenderEntityId[];
}

/**
 * Computes camera frustum visibility using bounding sphere checks and bitwise layer matching.
 * Outputs a sorted list of visible render entity IDs.
 */
export function computeVisibility(
  view: RenderView,
  candidates: readonly VisibilityCandidate[]
): ViewVisibilitySnapshot {
  const entities = candidates
    .filter((candidate) => (candidate.layerMask & view.layerMask) !== 0)
    .filter((candidate) => view.containsSphere(candidate.center, candidate.radius))
    .map((candidate) => candidate.entity)
    .sort((left, right) => left - right);
  return Object.freeze({ viewId: view.id, entities: Object.freeze(entities) });
}
