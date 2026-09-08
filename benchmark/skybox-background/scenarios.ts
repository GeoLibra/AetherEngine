/**
 * @file Deterministic benchmark scenarios for Skybox / HDR Background.
 */

import {
  BENCHMARK_VIEWPORTS,
  createPerspectiveCameraFixture,
  createOrthographicCameraFixture,
  type BenchmarkViewport,
  type BenchmarkCameraFixture
} from './fixtures';
import {
  computeAngularError,
  computeFullscreenVertexRays,
  perFragmentCameraRayOracle,
  vertexInterpolatedCameraRayOracle
} from './oracle';

export interface DirectionReconstructionStats {
  readonly maxAngularError: number;
  readonly meanAngularError: number;
  readonly sampleCount: number;
}

/**
 * Sweeps a viewport comparing vertex-interpolated rays against full per-fragment inverse projection.
 */
export function benchmarkDirectionReconstruction(
  fixture: BenchmarkCameraFixture,
  viewport: BenchmarkViewport,
  step = 8
): DirectionReconstructionStats {
  const vertexRays = computeFullscreenVertexRays(fixture);
  let maxError = 0;
  let totalError = 0;
  let samples = 0;

  for (let y = 0; y < viewport.height; y += step) {
    for (let x = 0; x < viewport.width; x += step) {
      const fragRay = perFragmentCameraRayOracle(fixture, viewport, x, y);
      const vertRay = vertexInterpolatedCameraRayOracle(vertexRays, viewport, x, y);
      const err = computeAngularError(fragRay, vertRay);
      if (err > maxError) maxError = err;
      totalError += err;
      samples++;
    }
  }

  return Object.freeze({
    maxAngularError: maxError,
    meanAngularError: samples > 0 ? totalError / samples : 0,
    sampleCount: samples
  });
}

export interface PassMergingSimulationResult {
  readonly mode: 'merged' | 'separate';
  readonly physicalPassCount: number;
  readonly colorAttachmentOperations: number; // load + store
  readonly depthAttachmentOperations: number; // load + store
  readonly totalAttachmentBandwidthEvents: number;
}

/**
 * Simulates structural attachment operations for merged vs separate execution passes.
 */
export function simulatePassMerging(
  mode: 'merged' | 'separate',
  opaqueCoverage: 0 | 50 | 100
): PassMergingSimulationResult {
  if (mode === 'merged') {
    // 1 physical pass:
    // Color: 1 clear/load at begin, 1 store at end (2 ops)
    // Depth: 1 clear/load at begin, 1 store at end (2 ops)
    // Background draws unconditionally; Opaque draws with depth write/test.
    return Object.freeze({
      mode: 'merged',
      physicalPassCount: 1,
      colorAttachmentOperations: 2,
      depthAttachmentOperations: 2,
      totalAttachmentBandwidthEvents: 4
    });
  } else {
    // 2 physical passes:
    // Pass 1 (Background):
    // Color: 1 clear/load, 1 store (2 ops)
    // Depth: not attached (0 ops)
    // Pass 2 (Opaque):
    // Color: 1 load, 1 store (2 ops)
    // Depth: 1 clear/load, 1 store (2 ops)
    return Object.freeze({
      mode: 'separate',
      physicalPassCount: 2,
      colorAttachmentOperations: 4,
      depthAttachmentOperations: 2,
      totalAttachmentBandwidthEvents: 6
    });
  }
}
