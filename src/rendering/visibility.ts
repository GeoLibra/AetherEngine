import { ALL_FRUSTUM_PLANES, Frustum, type Vec3 } from '../math';
import type { RenderEntityId } from './render-world';
import type { ExtractedView } from './camera';

export type WorldBounds =
  | { readonly kind: 'sphere'; readonly center: Vec3; readonly radius: number }
  | { readonly kind: 'aabb'; readonly min: Vec3; readonly max: Vec3 };

export interface VisibilityCandidate {
  readonly entity: RenderEntityId;
  readonly enabled?: boolean;
  readonly layerMask: number;
  readonly bounds?: WorldBounds;
  /** @deprecated Use bounds. Retained for source compatibility. */
  readonly center?: Vec3;
  /** @deprecated Use bounds. Retained for source compatibility. */
  readonly radius?: number;
  readonly boundsRevision?: number;
  readonly lod?: number;
  readonly visibilityFlags?: number;
}

export interface RenderView {
  readonly id: string;
  readonly camera: RenderEntityId;
  readonly surface: string;
  readonly viewport: Readonly<{ x: number; y: number; width: number; height: number }>;
  readonly layerMask: number;
  readonly featurePolicyKey: string;
  readonly historyKey: string;
  readonly viewRevision?: number;
  readonly frustum?: Frustum;
  readonly viewMatrix?: ArrayLike<number>;
  /** @deprecated Supply frustum for plane-tested visibility. */
  readonly containsSphere?: (center: Vec3, radius: number) => boolean;
}

export interface VisibleItem {
  readonly renderEntity: RenderEntityId;
  readonly boundsRevision: number;
  readonly depthRange: readonly [number, number];
  readonly lod: number;
  readonly visibilityFlags: number;
}

export interface VisibilityCounters {
  readonly candidates: number;
  readonly layerRejected: number;
  readonly disabledRejected: number;
  readonly frustumRejected: number;
  readonly retained: number;
  readonly planeTests: number;
  readonly conservativeFallbackRetained: number;
}

export interface ViewVisibilitySnapshot {
  readonly viewId: string;
  readonly viewRevision: number;
  readonly source: 'cpu';
  readonly entities: readonly RenderEntityId[];
  readonly items: readonly VisibleItem[];
  readonly overflowed: false;
  readonly counters: VisibilityCounters;
}

export function computeVisibility(
  view: RenderView,
  candidates: readonly VisibilityCandidate[]
): ViewVisibilitySnapshot {
  const items: VisibleItem[] = [];
  let layerRejected = 0;
  let disabledRejected = 0;
  let frustumRejected = 0;
  let planeTests = 0;
  let conservativeFallbackRetained = 0;
  for (const candidate of candidates) {
    if (candidate.enabled === false) {
      disabledRejected++;
      continue;
    }
    if ((candidate.layerMask & view.layerMask) === 0) {
      layerRejected++;
      continue;
    }
    const bounds = resolveBounds(candidate);
    let visible = true;
    if (view.frustum) {
      const result =
        bounds.kind === 'sphere'
          ? view.frustum.classifySphere(bounds.center, bounds.radius, ALL_FRUSTUM_PLANES)
          : view.frustum.classifyAabb(bounds.min, bounds.max, ALL_FRUSTUM_PLANES);
      planeTests += result.planeTests;
      visible = result.intersection !== 'outside';
    } else if (view.containsSphere && bounds.kind === 'sphere') {
      visible = view.containsSphere(bounds.center, bounds.radius);
    } else {
      conservativeFallbackRetained++;
    }
    if (!visible) {
      frustumRejected++;
      continue;
    }
    items.push(
      Object.freeze({
        renderEntity: candidate.entity,
        boundsRevision: candidate.boundsRevision ?? 0,
        depthRange: boundsDepthRange(bounds, view.viewMatrix),
        lod: candidate.lod ?? 0,
        visibilityFlags: candidate.visibilityFlags ?? 0
      })
    );
  }
  items.sort((left, right) => left.renderEntity - right.renderEntity);
  const frozenItems = Object.freeze(items);
  return Object.freeze({
    viewId: view.id,
    viewRevision: view.viewRevision ?? 0,
    source: 'cpu',
    entities: Object.freeze(items.map((item) => item.renderEntity)),
    items: frozenItems,
    overflowed: false,
    counters: Object.freeze({
      candidates: candidates.length,
      layerRejected,
      disabledRejected,
      frustumRejected,
      retained: items.length,
      planeTests,
      conservativeFallbackRetained
    })
  });
}

export interface CpuVisibilityViewOptions {
  readonly surface: string;
  readonly featurePolicyKey: string;
  readonly historyKey: string;
}

export function createCpuVisibilityView(
  extracted: ExtractedView,
  options: CpuVisibilityViewOptions
): RenderView {
  return Object.freeze({
    id: extracted.viewId,
    camera: extracted.camera,
    surface: options.surface,
    viewport: extracted.viewportPixels,
    layerMask: extracted.layerMask,
    featurePolicyKey: options.featurePolicyKey,
    historyKey: options.historyKey,
    viewRevision: extracted.revision,
    frustum: Frustum.fromViewProjection(extracted.unjitteredViewProjection),
    viewMatrix: extracted.view
  });
}

function resolveBounds(candidate: VisibilityCandidate): WorldBounds {
  if (candidate.bounds) return candidate.bounds;
  if (candidate.center && candidate.radius !== undefined)
    return { kind: 'sphere', center: candidate.center, radius: candidate.radius };
  throw new Error(`Visibility candidate ${candidate.entity} has no bounds.`);
}

function boundsDepthRange(
  bounds: WorldBounds,
  viewMatrix: ArrayLike<number> | undefined
): readonly [number, number] {
  if (!viewMatrix) return [Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY];
  const m2 = viewMatrix[2]!;
  const m6 = viewMatrix[6]!;
  const m10 = viewMatrix[10]!;
  const m14 = viewMatrix[14]!;
  if (bounds.kind === 'sphere') {
    const centerDepth =
      m2 * bounds.center[0] + m6 * bounds.center[1] + m10 * bounds.center[2] + m14;
    const radius = bounds.radius * Math.hypot(m2, m6, m10);
    return [centerDepth - radius, centerDepth + radius];
  }
  let minimum = m14;
  let maximum = m14;
  for (const [coefficient, axis] of [
    [m2, 0],
    [m6, 1],
    [m10, 2]
  ] as const) {
    const first = coefficient * bounds.min[axis];
    const second = coefficient * bounds.max[axis];
    minimum += Math.min(first, second);
    maximum += Math.max(first, second);
  }
  return [minimum, maximum];
}
