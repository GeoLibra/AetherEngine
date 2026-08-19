import { Mat4 } from './matrix';
import type { Vec3, ViewportRect } from './types';

/**
 * Projects a 3D point from world space to 2D screen/viewport coordinates.
 *
 * Transformation steps:
 * 1. Transforms point into homogeneous clip space using the view-projection matrix.
 * 2. Performs perspective divide by clip-space `w` to calculate Normalized Device Coordinates (NDC, [-1, 1]).
 * 3. Maps NDC coordinates to the top-left-origin viewport pixel space (Y is inverted for DOM/screen coordinates).
 *
 * @param point - The 3D world-space coordinates [x, y, z].
 * @param viewProjection - The 4x4 View-Projection matrix (column-major).
 * @param viewport - The target viewport rectangle (origin and dimensions in pixels).
 * @returns The screen-space coordinates [screenX, screenY, depthZ].
 * @throws {Error} If viewport dimensions are invalid or clip-space `w` is near zero.
 */
export function projectPoint(
  point: Vec3,
  viewProjection: ArrayLike<number>,
  viewport: ViewportRect
): Vec3 {
  validateViewport(viewport);
  const clip = Mat4.transformPointHomogeneous(viewProjection, [...point, 1]);
  if (Math.abs(clip[3]) < 1e-12) {
    throw new Error('Cannot project a point with zero clip-space w.');
  }
  const inverseW = 1 / clip[3];
  const ndcX = clip[0] * inverseW;
  const ndcY = clip[1] * inverseW;
  return [
    viewport.x + (ndcX + 1) * 0.5 * viewport.width,
    viewport.y + (1 - ndcY) * 0.5 * viewport.height,
    clip[2] * inverseW
  ];
}

/**
 * Unprojects a point from 2D screen/viewport coordinates back to 3D world space.
 *
 * Transformation steps:
 * 1. Maps screen pixel coordinates to Normalized Device Coordinates (NDC, [-1, 1]), inverting Y back.
 * 2. Transforms NDC position with the inverse View-Projection matrix into homogeneous world space.
 * 3. Performs perspective divide by world-space `w` to obtain the final 3D world coordinates.
 *
 * Commonly used for mouse picking and raycasting (e.g., projecting screen points with near/far depth).
 *
 * @param screen - The screen-space coordinates [screenX, screenY, depthZ] with top-left origin.
 * @param inverseViewProjection - The inverted 4x4 View-Projection matrix (column-major).
 * @param viewport - The source viewport rectangle.
 * @returns The reconstructed 3D world-space coordinates [x, y, z].
 * @throws {Error} If viewport dimensions are invalid or world-space `w` is near zero.
 */
export function unprojectPoint(
  screen: Vec3,
  inverseViewProjection: ArrayLike<number>,
  viewport: ViewportRect
): Vec3 {
  validateViewport(viewport);
  const ndcX = ((screen[0] - viewport.x) / viewport.width) * 2 - 1;
  const ndcY = 1 - ((screen[1] - viewport.y) / viewport.height) * 2;
  const world = Mat4.transformPointHomogeneous(inverseViewProjection, [ndcX, ndcY, screen[2], 1]);
  if (Math.abs(world[3]) < 1e-12) {
    throw new Error('Cannot unproject a point with zero world-space w.');
  }
  const inverseW = 1 / world[3];
  return [world[0] * inverseW, world[1] * inverseW, world[2] * inverseW];
}

function validateViewport(viewport: ViewportRect): void {
  if (!(viewport.width > 0 && viewport.height > 0)) {
    throw new Error('Viewport width and height must be positive.');
  }
}
