import { Mat4 } from './matrix';
import type { Vec3, ViewportRect } from './types';

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
