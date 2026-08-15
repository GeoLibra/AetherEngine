import { ALL_FRUSTUM_PLANES } from '../../math';
import type { RenderView } from '../visibility/types';
import type { SpatialEntry } from './types';

export function isSpatialEntryVisible(
  view: RenderView,
  entry: SpatialEntry
): {
  readonly visible: boolean;
  readonly planeTests: number;
} {
  if (!entry.enabled || (entry.layerMask & view.layerMask) === 0)
    return { visible: false, planeTests: 0 };
  if (!view.frustum) return { visible: true, planeTests: 0 };
  const classification =
    entry.bounds.kind === 'sphere'
      ? view.frustum.classifySphere(entry.bounds.center, entry.bounds.radius, ALL_FRUSTUM_PLANES)
      : view.frustum.classifyAabb(entry.bounds.min, entry.bounds.max, ALL_FRUSTUM_PLANES);
  return {
    visible: classification.intersection !== 'outside',
    planeTests: classification.planeTests
  };
}

export function linearCullSpatialEntries(
  view: RenderView,
  entries: Iterable<SpatialEntry>
): readonly SpatialEntry[] {
  return Object.freeze(
    [...entries]
      .filter((entry) => isSpatialEntryVisible(view, entry).visible)
      .sort(compareSpatialEntries)
  );
}

export function compareSpatialEntries(left: SpatialEntry, right: SpatialEntry): number {
  return left.renderEntity - right.renderEntity || left.insertionOrder - right.insertionOrder;
}
