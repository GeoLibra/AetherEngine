import { ALL_FRUSTUM_PLANES, Frustum, type Vec3 } from '../math';
import type { ExtractedView } from './camera';
import type {
  CpuVisibilityViewOptions,
  RenderView,
  ViewVisibilitySnapshot,
  VisibilityCandidate,
  VisibleItem,
  WorldBounds
} from './visibility/types';

export type {
  CpuVisibilityViewOptions,
  RenderView,
  ViewVisibilitySnapshot,
  VisibilityCandidate,
  VisibilityCounters,
  VisibleItem,
  WorldBounds
} from './visibility/types';

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
    const bounds = candidate.bounds;
    let visible = true;
    if (view.frustum) {
      const result =
        bounds.kind === 'sphere'
          ? view.frustum.classifySphere(bounds.center, bounds.radius, ALL_FRUSTUM_PLANES)
          : view.frustum.classifyAabb(bounds.min, bounds.max, ALL_FRUSTUM_PLANES);
      planeTests += result.planeTests;
      visible = result.intersection !== 'outside';
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
