import { Mat4 } from '../../../math';
import type { ExtractedView } from '../../camera';
import { buildClusterGrid, type ClusterGrid, type PreparedLight } from '../../lighting';

/**
 * Builds the baseline's bounded cluster grid in top-left fragment row order.
 * Infinite cameras bound local lighting by world-space influence spheres transformed into
 * positive camera depth; directional lights use the global list. The camera snapshot is untouched.
 * @throws If projection inversion or the derived finite grid bounds are invalid.
 */
export function buildBaselineClusterGrid(
  view: ExtractedView,
  lights: readonly PreparedLight[],
  deviceGeneration: number
): ClusterGrid {
  const far = view.far === 'infinite' ? localLightFar(view, lights) : view.far;
  const projection = Array.from(view.unjitteredProjection);
  // Cluster construction interpolates standard-depth near/far corners. Normalize reverse
  // depth here, without changing the camera matrices used by rasterization and visibility.
  if (view.depthMode === 'reverse') {
    for (let column = 0; column < 4; column++) {
      const row = column * 4;
      projection[row + 2] = projection[row + 3]! - projection[row + 2]!;
    }
  }
  if (view.far === 'infinite') {
    // Replace only the perspective depth row, preserving asymmetric/jitter-free XY intent.
    projection[10] = far / (view.near - far);
    projection[14] = (far * view.near) / (view.near - far);
  }
  // Grid tile zero starts at NDC -1; fragment row zero starts at the top (+Y in clip space).
  for (let column = 0; column < 4; column++) projection[column * 4 + 1]! *= -1;
  return buildClusterGrid({
    viewId: view.viewId,
    projectionRevision: view.revision,
    viewTransformRevision: view.revision,
    deviceGeneration,
    viewport: view.viewportPixels,
    cameraNear: view.near,
    cameraFar: far,
    slicing: { depth: 'finite', shape: 'logarithmic', lambda: 0.6 },
    sliceCount: 8,
    inverseViewProjection: Mat4.invert(Mat4.multiply(projection, view.view)),
    tilesX: 8,
    tilesY: 4
  });
}

function localLightFar(view: ExtractedView, lights: readonly PreparedLight[]): number {
  let far = view.near * 2;
  for (const light of lights) {
    if (light.kind === 'directional' || !light.enabled) continue;
    const [x, y, z] = light.position;
    const m = view.view;
    const depth = -(m[2]! * x + m[6]! * y + m[10]! * z + m[14]!);
    far = Math.max(far, depth + light.range);
  }
  return far;
}
