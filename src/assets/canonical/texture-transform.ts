import type { TextureUvAffineTransform } from '../../material/builtins';
import type { TextureUvTransform } from './types';

/**
 * Composes a TextureUvTransform into a 2D affine transform (column-major 2x2 matrix and 2D translation offset).
 *
 * Multiplication order follows the glTF KHR_texture_transform specification:
 *   [ s_x * cos(r)   -s_y * sin(r) ] [ u ] + [ offset_x ]
 *   [ s_x * sin(r)    s_y * cos(r) ] [ v ]   [ offset_y ]
 *
 * Matrix is stored column-major: [ m00, m10, m01, m11 ] = [ sx*cos, sx*sin, -sy*sin, sy*cos ].
 * Offset is stored: [ tx, ty ].
 */
export function composeTextureUvTransform(
  transform?: Partial<TextureUvTransform>
): TextureUvAffineTransform {
  if (!transform) {
    return Object.freeze({
      matrix: Object.freeze([1, 0, 0, 1] as const),
      offset: Object.freeze([0, 0] as const)
    });
  }
  const sx = transform.scale?.[0] ?? 1;
  const sy = transform.scale?.[1] ?? 1;
  const tx = transform.offset?.[0] ?? 0;
  const ty = transform.offset?.[1] ?? 0;
  const r = transform.rotation ?? 0;
  const cosR = Math.cos(r);
  const sinR = Math.sin(r);
  const m1 = -sy * sinR;
  const m2 = sx * sinR;
  return Object.freeze({
    matrix: Object.freeze([sx * cosR, m1 === 0 ? 0 : m1, m2 === 0 ? 0 : m2, sy * cosR] as const),
    offset: Object.freeze([tx, ty] as const)
  });
}
