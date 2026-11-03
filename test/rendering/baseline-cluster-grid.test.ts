import { expect, test } from 'vitest';
import {
  Mat4,
  STANDARD_DEPTH,
  REVERSE_DEPTH,
  extractView,
  type PreparedLight,
  type RenderEntityId
} from '../../src';
import { buildBaselineClusterGrid } from '../../src/rendering/baseline/lighting/cluster-grid';

for (const depth of [STANDARD_DEPTH, REVERSE_DEPTH]) {
  for (const far of [40, 'infinite'] as const) {
    test(`bounds ${depth.mode} ${far} clusters in camera depth and top-left row order`, () => {
      const view = extractView({
        viewId: 'main',
        camera: 1 as RenderEntityId,
        revision: 1,
        view: Mat4.identity(),
        projection:
          far === 'infinite'
            ? Mat4.perspectiveInfinite(Math.PI / 2, 1, 1, depth)
            : Mat4.perspective(Math.PI / 2, 1, 1, far, depth),
        projectionDescriptor: {
          kind: 'perspective',
          near: 1,
          far,
          verticalFovRadians: Math.PI / 2
        },
        viewport: { logicalWidth: 64, logicalHeight: 64, devicePixelRatio: 1 },
        layerMask: 1,
        depthMode: depth.mode
      });
      const before = Array.from(view.projection);
      const light: PreparedLight = {
        entity: 2 as RenderEntityId,
        payloadVersion: 1,
        kind: 'point',
        position: [0, 0, -500],
        range: 20,
        colorLinear: [1, 1, 1],
        luminousIntensityCandela: 100,
        enabled: true,
        layerMask: 1,
        castsShadow: false
      };
      const grid = buildBaselineClusterGrid(view, [light], 7);
      expect(grid.cameraFar).toBe(far === 'infinite' ? 520 : 40);
      expect(grid.deviceGeneration).toBe(7);
      expect(grid.clusters).toHaveLength(256);
      expect(grid.clusters.every((cell) => [...cell.min, ...cell.max].every(Number.isFinite))).toBe(
        true
      );
      // The top-left cell's +Y world bounds must match fragment row zero.
      expect(grid.clusters[0]!.min[1]).toBeGreaterThan(0);
      const minZ = Math.min(...grid.clusters.map((cell) => cell.min[2]));
      expect(minZ).toBeCloseTo(far === 'infinite' ? -520 : -40, 2);
      expect(Array.from(view.projection)).toEqual(before);
    });
  }
}
