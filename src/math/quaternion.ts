import type { Quaternion, Vec3 } from './types';

const MIN_QUATERNION_LENGTH = 1e-8;

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
