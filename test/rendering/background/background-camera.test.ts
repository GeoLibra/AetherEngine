import { describe, expect, it } from 'vitest';
import { Mat4, Quat, STANDARD_DEPTH, REVERSE_DEPTH, Vec3Math } from '../../../src/math';
import {
  computeFullscreenVertexDirections,
  directionToEquirectUv,
  reconstructFragmentDirection
} from '../../../src/rendering/background/coordinates';

describe('background camera direction reconstruction and invariance', () => {
  it('guarantees translation invariance between origin and 1e8 world units', () => {
    const fov = Math.PI / 3;
    const aspect = 16 / 9;
    const proj = Mat4.perspective(fov, aspect, 0.1, 100, STANDARD_DEPTH);

    // Camera at origin
    const viewOrigin = Mat4.invert(Mat4.fromTranslation([0, 0, 0]));
    const raysOrigin = computeFullscreenVertexDirections({
      viewMatrix: viewOrigin,
      projectionMatrix: proj,
      projectionKind: 'perspective',
      depthMode: 'standard'
    });

    // Camera at 1e8 world units
    const viewFar = Mat4.invert(Mat4.fromTranslation([1e8, -1e8, 1e8]));
    const raysFar = computeFullscreenVertexDirections({
      viewMatrix: viewFar,
      projectionMatrix: proj,
      projectionKind: 'perspective',
      depthMode: 'standard'
    });

    for (const key of ['ray0', 'ray1', 'ray2'] as const) {
      expect(raysFar[key][0]).toBeCloseTo(raysOrigin[key][0], 5);
      expect(raysFar[key][1]).toBeCloseTo(raysOrigin[key][1], 5);
      expect(raysFar[key][2]).toBeCloseTo(raysOrigin[key][2], 5);
    }
  });

  it('maps +90-degree Y rotation +X environment landmark toward world -Z', () => {
    // Rotate camera around Y by +90 degrees (pi/2 radians)
    const rot = Quat.fromAxisAngle([0, 1, 0], Math.PI / 2);
    const view = Mat4.invert(Mat4.fromTRS([0, 0, 0], rot, [1, 1, 1]));
    const proj = Mat4.perspective(Math.PI / 3, 1, 0.1, 100, STANDARD_DEPTH);

    // Center pixel ray looking straight forward along camera -Z
    const dir = reconstructFragmentDirection({
      pixelX: 50,
      pixelY: 50,
      viewportWidth: 101,
      viewportHeight: 101,
      viewMatrix: view,
      projectionMatrix: proj,
      projectionKind: 'perspective',
      depthMode: 'standard'
    });

    // When looking straight forward with camera rotated +90 deg Y (looking toward world -X),
    // if environment is rotated +90 deg Y, +X environment landmark maps toward world -Z.
    const dirWithEnv = reconstructFragmentDirection({
      pixelX: 50,
      pixelY: 50,
      viewportWidth: 101,
      viewportHeight: 101,
      viewMatrix: Mat4.identity(),
      projectionMatrix: proj,
      projectionKind: 'perspective',
      depthMode: 'standard',
      environmentRotation: Quat.fromAxisAngle([0, 1, 0], Math.PI / 2)
    });

    // Looking forward at world -Z with environment rotated +90 deg Y:
    // +X landmark (u=0.5, v=0.5 in unrotated) is sampled along -Z.
    expect(dirWithEnv[0]).toBeCloseTo(1, 4); // +X environment coordinate
    expect(dirWithEnv[2]).toBeCloseTo(0, 4);
  });

  it('preserves constant direction across all pixels for orthographic camera', () => {
    const halfHeight = 5;
    const aspect = 2;
    const halfWidth = halfHeight * aspect;
    const proj = new Float32Array([
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
      -1 / 99.9,
      0,
      0,
      0,
      -0.1 / 99.9,
      1
    ]);

    const view = Mat4.identity();
    const rays = computeFullscreenVertexDirections({
      viewMatrix: view,
      projectionMatrix: proj,
      projectionKind: 'orthographic',
      depthMode: 'standard'
    });

    // All vertex rays are identical (0, 0, -1)
    expect(rays.ray0).toEqual(rays.ray1);
    expect(rays.ray1).toEqual(rays.ray2);
    expect(rays.ray0[0]).toBe(0);
    expect(rays.ray0[1]).toBe(0);
    expect(rays.ray0[2]).toBe(-1);

    // Any fragment reconstruction gives the exact same direction
    const p1 = reconstructFragmentDirection({
      pixelX: 10,
      pixelY: 10,
      viewportWidth: 100,
      viewportHeight: 100,
      viewMatrix: view,
      projectionMatrix: proj,
      projectionKind: 'orthographic',
      depthMode: 'standard'
    });
    const p2 = reconstructFragmentDirection({
      pixelX: 90,
      pixelY: 80,
      viewportWidth: 100,
      viewportHeight: 100,
      viewMatrix: view,
      projectionMatrix: proj,
      projectionKind: 'orthographic',
      depthMode: 'standard'
    });
    expect(p1).toEqual(p2);
  });

  it('achieves ray angular error <= 1e-4 radians between vertex interpolation and per-fragment reference', () => {
    const fov = Math.PI / 3;
    const aspect = 16 / 9;
    const proj = Mat4.perspective(fov, aspect, 0.1, 100, STANDARD_DEPTH);
    const view = Mat4.identity();

    const vertexRays = computeFullscreenVertexDirections({
      viewMatrix: view,
      projectionMatrix: proj,
      projectionKind: 'perspective',
      depthMode: 'standard'
    });

    const w = 128;
    const h = 72;

    for (let y = 0; y < h; y += 8) {
      for (let x = 0; x < w; x += 8) {
        const exact = reconstructFragmentDirection({
          pixelX: x,
          pixelY: y,
          viewportWidth: w,
          viewportHeight: h,
          viewMatrix: view,
          projectionMatrix: proj,
          projectionKind: 'perspective',
          depthMode: 'standard'
        });

        // Vertex interpolation emulation
        const u = (x + 0.5) / w;
        const v = (y + 0.5) / h;
        const r0 = vertexRays.ray0;
        const r1 = vertexRays.ray1;
        const r2 = vertexRays.ray2;

        const ix = r0[0] + (r1[0] - r0[0]) * 0.5 * u + (r2[0] - r0[0]) * 0.5 * (1 - v);
        const iy = r0[1] + (r1[1] - r0[1]) * 0.5 * u + (r2[1] - r0[1]) * 0.5 * (1 - v);
        const iz = r0[2] + (r1[2] - r0[2]) * 0.5 * u + (r2[2] - r0[2]) * 0.5 * (1 - v);
        const interpolated = Vec3Math.normalize([ix, iy, iz]);

        const dot = Vec3Math.dot(exact, interpolated);
        const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
        expect(angle).toBeLessThan(1e-4);
      }
    }
  });
});
