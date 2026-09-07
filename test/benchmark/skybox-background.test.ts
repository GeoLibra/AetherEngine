import { describe, expect, it } from 'vitest';
import {
  BENCHMARK_VIEWPORTS,
  createPerspectiveCameraFixture,
  createOrthographicCameraFixture
} from '../../benchmark/skybox-background/fixtures';
import {
  computeAngularError,
  computeFullscreenVertexRays,
  perFragmentCameraRayOracle,
  vertexInterpolatedCameraRayOracle
} from '../../benchmark/skybox-background/oracle';
import {
  benchmarkDirectionReconstruction,
  simulatePassMerging
} from '../../benchmark/skybox-background/scenarios';

describe('skybox background benchmark and mathematical foundation', () => {
  it('achieves angular error <= 1e-4 between vertex interpolation and per-fragment inverse projection', () => {
    const fixture = createPerspectiveCameraFixture(BENCHMARK_VIEWPORTS.smoke);
    const stats = benchmarkDirectionReconstruction(fixture, BENCHMARK_VIEWPORTS.smoke, 4);

    expect(stats.sampleCount).toBeGreaterThan(0);
    expect(stats.maxAngularError).toBeLessThan(1e-4);
  });

  it('preserves exact direction in orthographic camera mode across all viewport samples', () => {
    const fixture = createOrthographicCameraFixture(BENCHMARK_VIEWPORTS.smoke);
    const stats = benchmarkDirectionReconstruction(fixture, BENCHMARK_VIEWPORTS.smoke, 4);

    expect(stats.sampleCount).toBeGreaterThan(0);
    expect(stats.maxAngularError).toBeLessThan(1e-6);
  });

  it('supports reverse-depth perspective projection with accurate ray reconstruction', () => {
    const fixture = createPerspectiveCameraFixture(BENCHMARK_VIEWPORTS.smoke, {
      depthMode: 'reverse'
    });
    const stats = benchmarkDirectionReconstruction(fixture, BENCHMARK_VIEWPORTS.smoke, 4);

    expect(stats.sampleCount).toBeGreaterThan(0);
    expect(stats.maxAngularError).toBeLessThan(1e-4);
  });

  it('verifies structural attachment operations between merged and separate passes', () => {
    const merged = simulatePassMerging('merged', 50);
    const separate = simulatePassMerging('separate', 50);

    expect(merged.physicalPassCount).toBe(1);
    expect(separate.physicalPassCount).toBe(2);
    expect(merged.colorAttachmentOperations).toBeLessThan(separate.colorAttachmentOperations);
    expect(merged.totalAttachmentBandwidthEvents).toBe(4);
    expect(separate.totalAttachmentBandwidthEvents).toBe(6);
  });
});
