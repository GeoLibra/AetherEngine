import { bench, expect } from 'vitest';
import {
  BENCHMARK_VIEWPORTS,
  createPerspectiveCameraFixture,
  createOrthographicCameraFixture
} from './skybox-background/fixtures';
import {
  benchmarkDirectionReconstruction,
  simulatePassMerging
} from './skybox-background/scenarios';

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';

const viewport =
  profile === 'nightly'
    ? BENCHMARK_VIEWPORTS.p1080
    : profile === 'standard'
      ? BENCHMARK_VIEWPORTS.p720
      : BENCHMARK_VIEWPORTS.smoke;

const step = profile === 'nightly' ? 4 : profile === 'standard' ? 8 : 4;

const perspectiveCamera = createPerspectiveCameraFixture(viewport);
const reverseDepthCamera = createPerspectiveCameraFixture(viewport, { depthMode: 'reverse' });
const orthographicCamera = createOrthographicCameraFixture(viewport);

bench(`vertex direction reconstruction perspective ${viewport.width}x${viewport.height}`, () => {
  const stats = benchmarkDirectionReconstruction(perspectiveCamera, viewport, step);
  expect(stats.maxAngularError).toBeLessThan(1e-4);
  expect(stats.sampleCount).toBeGreaterThan(0);
});

bench(`vertex direction reconstruction reverse-depth ${viewport.width}x${viewport.height}`, () => {
  const stats = benchmarkDirectionReconstruction(reverseDepthCamera, viewport, step);
  expect(stats.maxAngularError).toBeLessThan(1e-4);
  expect(stats.sampleCount).toBeGreaterThan(0);
});

bench(`vertex direction reconstruction orthographic ${viewport.width}x${viewport.height}`, () => {
  const stats = benchmarkDirectionReconstruction(orthographicCamera, viewport, step);
  expect(stats.maxAngularError).toBeLessThan(1e-6);
  expect(stats.sampleCount).toBeGreaterThan(0);
});

bench('merged physical render pass structural operations', () => {
  const merged = simulatePassMerging('merged', 50);
  expect(merged.physicalPassCount).toBe(1);
  expect(merged.totalAttachmentBandwidthEvents).toBe(4);
});

bench('separate physical render pass structural operations', () => {
  const separate = simulatePassMerging('separate', 50);
  expect(separate.physicalPassCount).toBe(2);
  expect(separate.totalAttachmentBandwidthEvents).toBe(6);
});
