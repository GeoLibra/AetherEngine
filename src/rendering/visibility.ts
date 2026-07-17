import type { RenderEntityId } from './render-world';

export interface VisibilityCandidate {
  readonly entity: RenderEntityId;
  readonly layerMask: number;
  readonly center: readonly [number, number, number];
  readonly radius: number;
}
export interface RenderView {
  readonly id: string;
  readonly camera: RenderEntityId;
  readonly surface: string;
  readonly viewport: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly layerMask: number;
  readonly featurePolicyKey: string;
  readonly historyKey: string;
  readonly containsSphere: (center: readonly [number, number, number], radius: number) => boolean;
}
export interface ViewVisibilitySnapshot {
  readonly viewId: string;
  readonly entities: readonly RenderEntityId[];
}

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
