/**
 * @file Benchmark fixtures for Skybox / HDR Background.
 * Provides deterministic camera view matrices, projections, and test scenes.
 */

import { Mat4, REVERSE_DEPTH, STANDARD_DEPTH } from '../../src/math';
import type { CameraProjection } from '../../src/rendering/camera/types/camera-types';

export interface BenchmarkViewport {
  readonly width: number;
  readonly height: number;
}

export interface BenchmarkCameraFixture {
  readonly label: string;
  readonly projection: CameraProjection;
  readonly viewMatrix: Float32Array;
  readonly projectionMatrix: Float32Array;
  readonly depthMode: 'standard' | 'reverse';
  readonly jitter: readonly [number, number];
}

export const BENCHMARK_VIEWPORTS = Object.freeze({
  smoke: Object.freeze({ width: 128, height: 128 }),
  p720: Object.freeze({ width: 1280, height: 720 }),
  p1080: Object.freeze({ width: 1920, height: 1080 })
});

/**
 * Creates standard perspective camera matrices for benchmarking.
 */
export function createPerspectiveCameraFixture(
  viewport: BenchmarkViewport,
  options: {
    depthMode?: 'standard' | 'reverse';
    jitter?: readonly [number, number];
    fovRadians?: number;
    position?: readonly [number, number, number];
  } = {}
): BenchmarkCameraFixture {
  const depthMode = options.depthMode ?? 'standard';
  const fov = options.fovRadians ?? Math.PI / 3;
  const aspect = viewport.width / viewport.height;
  const near = 0.1;
  const far = 100.0;
  const pos = options.position ?? [0, 1.5, 3];
  const jitter = options.jitter ?? [0, 0];

  // Camera world transform with translation and identity rotation
  const worldMatrix = Mat4.fromTranslation(pos);
  const viewMatrix = Mat4.invert(worldMatrix);

  const depthConvention = depthMode === 'standard' ? STANDARD_DEPTH : REVERSE_DEPTH;
  const projectionMatrix = Mat4.perspective(fov, aspect, near, far, depthConvention);

  return Object.freeze({
    label: `perspective-${viewport.width}x${viewport.height}-${depthMode}`,
    projection: Object.freeze({
      kind: 'perspective',
      near,
      far,
      verticalFovRadians: fov
    }),
    viewMatrix,
    projectionMatrix,
    depthMode,
    jitter
  });
}

/**
 * Creates orthographic camera matrices for benchmarking.
 */
export function createOrthographicCameraFixture(
  viewport: BenchmarkViewport,
  options: {
    depthMode?: 'standard' | 'reverse';
    halfHeight?: number;
    position?: readonly [number, number, number];
  } = {}
): BenchmarkCameraFixture {
  const depthMode = options.depthMode ?? 'standard';
  const halfHeight = options.halfHeight ?? 5.0;
  const aspect = viewport.width / viewport.height;
  const halfWidth = halfHeight * aspect;
  const near = 0.1;
  const far = 100.0;
  const pos = options.position ?? [0, 5, 10];

  const worldMatrix = Mat4.fromTranslation(pos);
  const viewMatrix = Mat4.invert(worldMatrix);

  const depthScale = depthMode === 'standard' ? 1 / (near - far) : 1 / (far - near);
  const depthOffset = depthMode === 'standard' ? near / (near - far) : far / (far - near);

  const projectionMatrix = new Float32Array([
    1 / halfWidth,
    0,
    0,
    0,
    0,
    1 / halfHeight,
    0,
    0,
    0,
    0,
    depthScale,
    0,
    0,
    0,
    depthOffset,
    1
  ]);

  return Object.freeze({
    label: `orthographic-${viewport.width}x${viewport.height}-${depthMode}`,
    projection: Object.freeze({
      kind: 'orthographic',
      near,
      far,
      orthographicHalfHeight: halfHeight
    }),
    viewMatrix,
    projectionMatrix,
    depthMode,
    jitter: [0, 0] as const
  });
}
