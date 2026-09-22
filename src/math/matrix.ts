import { STANDARD_DEPTH } from './depth';
import { Quat } from './quaternion';
import type { DepthConvention, Quaternion, Vec3, Vec4 } from './types';

export const Mat4 = Object.freeze({
  identity(): Float32Array {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  },

  multiply(left: ArrayLike<number>, right: ArrayLike<number>): Float32Array {
    const result = new Float32Array(16);
    for (let column = 0; column < 4; column++) {
      for (let row = 0; row < 4; row++) {
        let value = 0;
        for (let index = 0; index < 4; index++) {
          value += left[index * 4 + row]! * right[column * 4 + index]!;
        }
        result[column * 4 + row] = value;
      }
    }
    return result;
  },

  fromTranslation(translation: Vec3): Float32Array {
    const result = Mat4.identity();
    result[12] = translation[0];
    result[13] = translation[1];
    result[14] = translation[2];
    return result;
  },

  fromScale(scale: Vec3): Float32Array {
    const result = Mat4.identity();
    result[0] = scale[0];
    result[5] = scale[1];
    result[10] = scale[2];
    return result;
  },

  fromTRS(translation: Vec3, rotation: Quaternion, scale: Vec3): Float32Array {
    const [x, y, z, w] = Quat.normalize(rotation);
    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;
    return new Float32Array([
      (1 - 2 * (yy + zz)) * scale[0],
      2 * (xy + wz) * scale[0],
      2 * (xz - wy) * scale[0],
      0,
      2 * (xy - wz) * scale[1],
      (1 - 2 * (xx + zz)) * scale[1],
      2 * (yz + wx) * scale[1],
      0,
      2 * (xz + wy) * scale[2],
      2 * (yz - wx) * scale[2],
      (1 - 2 * (xx + yy)) * scale[2],
      0,
      translation[0],
      translation[1],
      translation[2],
      1
    ]);
  },

  perspective(
    verticalFov: number,
    aspect: number,
    near: number,
    far: number,
    depth: DepthConvention = STANDARD_DEPTH
  ): Float32Array {
    if (!(verticalFov > 0 && verticalFov < Math.PI)) {
      throw new Error('Perspective verticalFov must be between zero and PI radians.');
    }
    if (!(aspect > 0 && near > 0 && far > near)) {
      throw new Error('Perspective requires positive aspect and 0 < near < far.');
    }
    const focal = 1 / Math.tan(verticalFov * 0.5);
    const depthScale = depth.mode === 'standard' ? far / (near - far) : near / (far - near);
    const depthOffset =
      depth.mode === 'standard' ? (far * near) / (near - far) : (far * near) / (far - near);
    return new Float32Array([
      focal / aspect,
      0,
      0,
      0,
      0,
      focal,
      0,
      0,
      0,
      0,
      depthScale,
      -1,
      0,
      0,
      depthOffset,
      0
    ]);
  },

  /**
   * Builds a right-handed zero-to-one-depth perspective projection with no finite far clip.
   *
   * The resulting matrix remains invertible. CPU culling must pair it with a frustum that
   * treats the far half-space as unbounded rather than attempting to normalize its zero normal.
   */
  perspectiveInfinite(
    verticalFov: number,
    aspect: number,
    near: number,
    depth: DepthConvention = STANDARD_DEPTH
  ): Float32Array {
    if (!(verticalFov > 0 && verticalFov < Math.PI)) {
      throw new Error('Perspective verticalFov must be between zero and PI radians.');
    }
    if (!(aspect > 0 && near > 0)) {
      throw new Error('Infinite perspective requires positive aspect and near plane.');
    }
    const focal = 1 / Math.tan(verticalFov * 0.5);
    const depthScale = depth.mode === 'standard' ? -1 : 0;
    const depthOffset = depth.mode === 'standard' ? -near : near;
    return new Float32Array([
      focal / aspect,
      0,
      0,
      0,
      0,
      focal,
      0,
      0,
      0,
      0,
      depthScale,
      -1,
      0,
      0,
      depthOffset,
      0
    ]);
  },

  transformPoint(matrix: ArrayLike<number>, point: Vec3): Vec3 {
    const transformed = Mat4.transformPointHomogeneous(matrix, [...point, 1]);
    const inverseW = transformed[3] === 0 ? 1 : 1 / transformed[3];
    return [transformed[0] * inverseW, transformed[1] * inverseW, transformed[2] * inverseW];
  },

  transformDirection(matrix: ArrayLike<number>, direction: Vec3): Vec3 {
    const transformed = Mat4.transformPointHomogeneous(matrix, [...direction, 0]);
    return [transformed[0], transformed[1], transformed[2]];
  },

  transformPointHomogeneous(matrix: ArrayLike<number>, point: Vec4): Vec4 {
    return [
      matrix[0]! * point[0] +
        matrix[4]! * point[1] +
        matrix[8]! * point[2] +
        matrix[12]! * point[3],
      matrix[1]! * point[0] +
        matrix[5]! * point[1] +
        matrix[9]! * point[2] +
        matrix[13]! * point[3],
      matrix[2]! * point[0] +
        matrix[6]! * point[1] +
        matrix[10]! * point[2] +
        matrix[14]! * point[3],
      matrix[3]! * point[0] +
        matrix[7]! * point[1] +
        matrix[11]! * point[2] +
        matrix[15]! * point[3]
    ];
  },

  invert(matrix: ArrayLike<number>): Float32Array {
    const result = invertMatrix(matrix);
    if (!result) {
      throw new Error('Matrix is singular and cannot be inverted.');
    }
    return result;
  },

  determinant(matrix: ArrayLike<number>): number {
    const m = matrix;
    return (
      m[0]! *
        (m[5]! * (m[10]! * m[15]! - m[14]! * m[11]!) -
          m[9]! * (m[6]! * m[15]! - m[14]! * m[7]!) +
          m[13]! * (m[6]! * m[11]! - m[10]! * m[7]!)) -
      m[4]! *
        (m[1]! * (m[10]! * m[15]! - m[14]! * m[11]!) -
          m[9]! * (m[2]! * m[15]! - m[14]! * m[3]!) +
          m[13]! * (m[2]! * m[11]! - m[10]! * m[3]!)) +
      m[8]! *
        (m[1]! * (m[6]! * m[15]! - m[14]! * m[7]!) -
          m[5]! * (m[2]! * m[15]! - m[14]! * m[3]!) +
          m[13]! * (m[2]! * m[7]! - m[6]! * m[3]!)) -
      m[12]! *
        (m[1]! * (m[6]! * m[11]! - m[10]! * m[7]!) -
          m[5]! * (m[2]! * m[11]! - m[10]! * m[3]!) +
          m[9]! * (m[2]! * m[7]! - m[6]! * m[3]!))
    );
  },

  normalMatrix(matrix: ArrayLike<number>): Float32Array {
    const inverse = Mat4.invert(matrix);
    return new Float32Array([
      inverse[0]!,
      inverse[4]!,
      inverse[8]!,
      inverse[1]!,
      inverse[5]!,
      inverse[9]!,
      inverse[2]!,
      inverse[6]!,
      inverse[10]!
    ]);
  },

  decomposeTRS(
    matrix: ArrayLike<number>,
    shearTolerance = 1e-5
  ): { readonly translation: Vec3; readonly rotation: Quaternion; readonly scale: Vec3 } {
    const translation: Vec3 = [matrix[12]!, matrix[13]!, matrix[14]!];
    const column0: Vec3 = [matrix[0]!, matrix[1]!, matrix[2]!];
    const column1: Vec3 = [matrix[4]!, matrix[5]!, matrix[6]!];
    const column2: Vec3 = [matrix[8]!, matrix[9]!, matrix[10]!];
    let scaleX = Math.hypot(...column0);
    const scaleY = Math.hypot(...column1);
    const scaleZ = Math.hypot(...column2);
    if (scaleX < 1e-8 || scaleY < 1e-8 || scaleZ < 1e-8) {
      throw new Error('Cannot decompose a singular transform matrix.');
    }
    if (Mat4.determinant(matrix) < 0) {
      scaleX = -scaleX;
    }
    const axis0 = scaleVector(column0, 1 / scaleX);
    const axis1 = scaleVector(column1, 1 / scaleY);
    const axis2 = scaleVector(column2, 1 / scaleZ);
    if (
      Math.abs(dot(axis0, axis1)) > shearTolerance ||
      Math.abs(dot(axis0, axis2)) > shearTolerance ||
      Math.abs(dot(axis1, axis2)) > shearTolerance
    ) {
      throw new Error('Transform matrix contains shear beyond the supported tolerance.');
    }
    return Object.freeze({
      translation,
      rotation: quaternionFromAxes(axis0, axis1, axis2),
      scale: [scaleX, scaleY, scaleZ] as Vec3
    });
  }
});

function invertMatrix(matrix: ArrayLike<number>): Float32Array | undefined {
  const m = matrix;
  const b00 = m[0]! * m[5]! - m[1]! * m[4]!;
  const b01 = m[0]! * m[6]! - m[2]! * m[4]!;
  const b02 = m[0]! * m[7]! - m[3]! * m[4]!;
  const b03 = m[1]! * m[6]! - m[2]! * m[5]!;
  const b04 = m[1]! * m[7]! - m[3]! * m[5]!;
  const b05 = m[2]! * m[7]! - m[3]! * m[6]!;
  const b06 = m[8]! * m[13]! - m[9]! * m[12]!;
  const b07 = m[8]! * m[14]! - m[10]! * m[12]!;
  const b08 = m[8]! * m[15]! - m[11]! * m[12]!;
  const b09 = m[9]! * m[14]! - m[10]! * m[13]!;
  const b10 = m[9]! * m[15]! - m[11]! * m[13]!;
  const b11 = m[10]! * m[15]! - m[11]! * m[14]!;
  let determinant = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
    return undefined;
  }
  determinant = 1 / determinant;
  return new Float32Array([
    (m[5]! * b11 - m[6]! * b10 + m[7]! * b09) * determinant,
    (m[2]! * b10 - m[1]! * b11 - m[3]! * b09) * determinant,
    (m[13]! * b05 - m[14]! * b04 + m[15]! * b03) * determinant,
    (m[10]! * b04 - m[9]! * b05 - m[11]! * b03) * determinant,
    (m[6]! * b08 - m[4]! * b11 - m[7]! * b07) * determinant,
    (m[0]! * b11 - m[2]! * b08 + m[3]! * b07) * determinant,
    (m[14]! * b02 - m[12]! * b05 - m[15]! * b01) * determinant,
    (m[8]! * b05 - m[10]! * b02 + m[11]! * b01) * determinant,
    (m[4]! * b10 - m[5]! * b08 + m[7]! * b06) * determinant,
    (m[1]! * b08 - m[0]! * b10 - m[3]! * b06) * determinant,
    (m[12]! * b04 - m[13]! * b02 + m[15]! * b00) * determinant,
    (m[9]! * b02 - m[8]! * b04 - m[11]! * b00) * determinant,
    (m[5]! * b07 - m[4]! * b09 - m[6]! * b06) * determinant,
    (m[0]! * b09 - m[1]! * b07 + m[2]! * b06) * determinant,
    (m[13]! * b01 - m[12]! * b03 - m[14]! * b00) * determinant,
    (m[8]! * b03 - m[9]! * b01 + m[10]! * b00) * determinant
  ]);
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function scaleVector(value: Vec3, scale: number): Vec3 {
  return [value[0] * scale, value[1] * scale, value[2] * scale];
}

function quaternionFromAxes(xAxis: Vec3, yAxis: Vec3, zAxis: Vec3): Quaternion {
  const m00 = xAxis[0];
  const m11 = yAxis[1];
  const m22 = zAxis[2];
  const trace = m00 + m11 + m22;
  let quaternion: Quaternion;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    quaternion = [
      (yAxis[2] - zAxis[1]) / scale,
      (zAxis[0] - xAxis[2]) / scale,
      (xAxis[1] - yAxis[0]) / scale,
      scale * 0.25
    ];
  } else if (m00 > m11 && m00 > m22) {
    const scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
    quaternion = [
      scale * 0.25,
      (xAxis[1] + yAxis[0]) / scale,
      (zAxis[0] + xAxis[2]) / scale,
      (yAxis[2] - zAxis[1]) / scale
    ];
  } else if (m11 > m22) {
    const scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
    quaternion = [
      (xAxis[1] + yAxis[0]) / scale,
      scale * 0.25,
      (yAxis[2] + zAxis[1]) / scale,
      (zAxis[0] - xAxis[2]) / scale
    ];
  } else {
    const scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
    quaternion = [
      (zAxis[0] + xAxis[2]) / scale,
      (yAxis[2] + zAxis[1]) / scale,
      scale * 0.25,
      (xAxis[1] - yAxis[0]) / scale
    ];
  }
  return Quat.normalize(quaternion);
}
