import type { EulerYXZ, Quaternion, Vec3 } from './types';

const MIN_QUATERNION_LENGTH = 1e-8;
const SINGULAR_COSINE_EPSILON = Math.sqrt(Number.EPSILON) * 2;
const TWO_PI = Math.PI * 2;

export const Quat = Object.freeze({
  identity(): Quaternion {
    return [0, 0, 0, 1];
  },

  normalize(value: Quaternion): Quaternion {
    const length = Math.hypot(value[0], value[1], value[2], value[3]);
    if (!Number.isFinite(length) || length < MIN_QUATERNION_LENGTH) {
      throw new Error('Cannot normalize a near-zero quaternion.');
    }
    const inverse = 1 / length;
    return [
      value[0] * inverse,
      value[1] * inverse,
      value[2] * inverse,
      value[3] * inverse
    ];
  },

  fromAxisAngle(axis: Vec3, radians: number): Quaternion {
    const length = Math.hypot(axis[0], axis[1], axis[2]);
    if (!Number.isFinite(length) || length < MIN_QUATERNION_LENGTH) {
      throw new Error('Quaternion axis must not be near-zero.');
    }
    const half = radians * 0.5;
    const scale = Math.sin(half) / length;
    return Quat.normalize([
      axis[0] * scale,
      axis[1] * scale,
      axis[2] * scale,
      Math.cos(half)
    ]);
  },

  fromEulerYXZ(euler: EulerYXZ): Quaternion {
    assertFiniteEuler(euler, 'Euler YXZ rotation');
    const [x, y, z] = euler;
    const halfX = x * 0.5;
    const halfY = y * 0.5;
    const halfZ = z * 0.5;
    const cx = Math.cos(halfX);
    const cy = Math.cos(halfY);
    const cz = Math.cos(halfZ);
    const sx = Math.sin(halfX);
    const sy = Math.sin(halfY);
    const sz = Math.sin(halfZ);
    return Quat.normalize([
      sx * cy * cz + cx * sy * sz,
      cx * sy * cz - sx * cy * sz,
      cx * cy * sz - sx * sy * cz,
      cx * cy * cz + sx * sy * sz
    ]);
  },

  toEulerYXZ(rotation: Quaternion): EulerYXZ {
    const normalized = Quat.normalize(rotation);
    const matrix = quaternionMatrixTerms(normalized);
    const sinX = clamp(-matrix.m23, -1, 1);
    const x = Math.asin(sinX);
    const cosX = Math.sqrt(Math.max(0, 1 - sinX * sinX));

    if (cosX <= SINGULAR_COSINE_EPSILON) {
      return [x, wrapPi(Math.atan2(-matrix.m31, matrix.m11)), 0];
    }
    return [
      x,
      wrapPi(Math.atan2(matrix.m13, matrix.m33)),
      wrapPi(Math.atan2(matrix.m21, matrix.m22))
    ];
  },

  multiply(left: Quaternion, right: Quaternion): Quaternion {
    const [ax, ay, az, aw] = left;
    const [bx, by, bz, bw] = right;
    return Quat.normalize([
      aw * bx + ax * bw + ay * bz - az * by,
      aw * by - ax * bz + ay * bw + az * bx,
      aw * bz + ax * by - ay * bx + az * bw,
      aw * bw - ax * bx - ay * by - az * bz
    ]);
  },

  slerp(start: Quaternion, end: Quaternion, alpha: number): Quaternion {
    if (!Number.isFinite(alpha)) {
      throw new Error('Quaternion interpolation alpha must be finite.');
    }
    const from = Quat.normalize(start);
    let to = Quat.normalize(end);
    let cosine =
      from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3];
    if (cosine < 0) {
      cosine = -cosine;
      to = [-to[0], -to[1], -to[2], -to[3]];
    }
    if (cosine > 0.9995) {
      return Quat.normalize([
        from[0] + (to[0] - from[0]) * alpha,
        from[1] + (to[1] - from[1]) * alpha,
        from[2] + (to[2] - from[2]) * alpha,
        from[3] + (to[3] - from[3]) * alpha
      ]);
    }
    const angle = Math.acos(Math.min(1, cosine));
    const inverseSine = 1 / Math.sin(angle);
    const fromWeight = Math.sin((1 - alpha) * angle) * inverseSine;
    const toWeight = Math.sin(alpha * angle) * inverseSine;
    return Quat.normalize([
      from[0] * fromWeight + to[0] * toWeight,
      from[1] * fromWeight + to[1] * toWeight,
      from[2] * fromWeight + to[2] * toWeight,
      from[3] * fromWeight + to[3] * toWeight
    ]);
  }
});

function assertFiniteEuler(value: EulerYXZ, label: string): void {
  if (!value.every(Number.isFinite)) {
    throw new Error(`${label} components must be finite.`);
  }
}

function quaternionMatrixTerms([x, y, z, w]: Quaternion) {
  return {
    m11: 1 - 2 * (y * y + z * z),
    m13: 2 * (x * z + y * w),
    m21: 2 * (x * y + z * w),
    m22: 1 - 2 * (x * x + z * z),
    m23: 2 * (y * z - x * w),
    m31: 2 * (x * z - y * w),
    m33: 1 - 2 * (x * x + y * y)
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function wrapPi(value: number): number {
  const wrapped = ((value + Math.PI) % TWO_PI + TWO_PI) % TWO_PI - Math.PI;
  return wrapped === -Math.PI ? Math.PI : wrapped;
}
