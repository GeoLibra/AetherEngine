import { Vec3Math } from '../../../math';
import type { Vec3 } from '../../../math/types';
import { Mat4 } from '../../../math';
import { normalizedLightDirection } from '../core/light';

export interface StableLightBasis {
  readonly x: Vec3;
  readonly y: Vec3;
  readonly z: Vec3;
  readonly upAxis: 'x' | 'y' | 'z';
}

export interface StableCascade {
  readonly centerWorld: Vec3;
  readonly rawRadius: number;
  readonly radius: number;
  readonly basis: StableLightBasis;
  readonly centerLightSpace: Vec3;
  readonly snappedCenterLightSpace: Vec3;
  readonly worldUnitsPerTexel: number;
  readonly boundsLightSpace: Readonly<{
    left: number;
    right: number;
    bottom: number;
    top: number;
    near: number;
    far: number;
  }>;
}

/** One directional cascade ready for caster projection and receiver selection. */
export interface DirectionalShadowCascade {
  readonly splitNear: number;
  readonly splitFar: number;
  readonly viewProjection: readonly number[];
  readonly stable: StableCascade;
}

/**
 * Builds stable world-to-shadow matrices from an unjittered camera frustum.
 * The current stable slice requires a finite camera far plane so all eight corners are projective.
 */
export function buildDirectionalShadowCascades(input: {
  readonly inverseViewProjection: ArrayLike<number>;
  readonly near: number;
  readonly far: number | 'infinite';
  readonly shadowDistance?: number;
  readonly lightDirection: Vec3;
  readonly cascadeCount?: number;
  readonly lambda?: number;
  readonly resolution?: number;
}): readonly DirectionalShadowCascade[] {
  if (input.inverseViewProjection.length !== 16) {
    throw new Error('Directional CSM inverse view-projection matrix must contain sixteen values.');
  }
  if (input.far === 'infinite') {
    throw new Error('Directional CSM requires a finite camera far plane.');
  }
  const cameraFarDistance = input.far;
  const shadowDistance = input.shadowDistance ?? cameraFarDistance;
  if (shadowDistance > cameraFarDistance) {
    throw new Error('Directional CSM shadow distance cannot exceed the camera far plane.');
  }
  const cascadeCount = input.cascadeCount ?? 4;
  const resolution = input.resolution ?? 1024;
  const splits = computeCascadeSplits(
    input.near,
    shadowDistance,
    cascadeCount,
    input.lambda ?? 0.6
  );
  const cameraNear = unprojectPlane(input.inverseViewProjection, 0);
  const cameraFar = unprojectPlane(input.inverseViewProjection, 1);
  let splitNear = input.near;
  return Object.freeze(
    splits.map((splitFar) => {
      const nearT = (splitNear - input.near) / (cameraFarDistance - input.near);
      const farT = (splitFar - input.near) / (cameraFarDistance - input.near);
      const corners = [
        ...cameraNear.map((corner, index) => lerp3(corner, cameraFar[index]!, nearT)),
        ...cameraNear.map((corner, index) => lerp3(corner, cameraFar[index]!, farT))
      ];
      const basis = stableLightBasis(input.lightDirection);
      const depths = corners.map((corner) => transformBasis(basis, corner)[2]);
      const padding = Math.max(0.01, (Math.max(...depths) - Math.min(...depths)) * 0.1);
      const stable = buildStableCascade({
        cornersWorld: corners,
        lightDirection: input.lightDirection,
        usableResolution: resolution,
        casterDepthRange: {
          min: Math.min(...depths) - padding,
          max: Math.max(...depths) + padding
        },
        radiusQuantum: 1 / 16
      });
      const cascade = Object.freeze({
        splitNear,
        splitFar,
        viewProjection: Object.freeze(worldToShadowMatrix(stable)),
        stable
      });
      splitNear = splitFar;
      return cascade;
    })
  );
}

export function computeCascadeSplits(
  near: number,
  shadowDistance: number,
  cascadeCount: number,
  lambda: number
): readonly number[] {
  if (!Number.isFinite(near) || near <= 0) throw new Error('CSM near must be positive and finite.');
  if (!Number.isFinite(shadowDistance) || shadowDistance <= near) {
    throw new Error('CSM shadow distance must be finite and greater than near.');
  }
  if (!Number.isSafeInteger(cascadeCount) || cascadeCount <= 0) {
    throw new Error('CSM cascade count must be a positive integer.');
  }
  if (!Number.isFinite(lambda)) throw new Error('CSM lambda must be finite.');
  const blend = Math.max(0, Math.min(1, lambda));
  return Object.freeze(
    Array.from({ length: cascadeCount }, (_, index) => {
      const portion = (index + 1) / cascadeCount;
      const logarithmic = near * Math.pow(shadowDistance / near, portion);
      const uniform = near + (shadowDistance - near) * portion;
      return blend * logarithmic + (1 - blend) * uniform;
    })
  );
}

/** Nearest texel with half ties rounded toward positive infinity. */
export function snapShadowCoordinate(value: number, worldUnitsPerTexel: number): number {
  if (!Number.isFinite(value)) throw new Error('Shadow snap value must be finite.');
  if (!Number.isFinite(worldUnitsPerTexel) || worldUnitsPerTexel <= 0) {
    throw new Error('Shadow worldUnitsPerTexel must be positive and finite.');
  }
  return Math.floor(value / worldUnitsPerTexel + 0.5) * worldUnitsPerTexel;
}

export function stableLightBasis(lightDirection: Vec3): StableLightBasis {
  const z = normalizedLightDirection(lightDirection);
  const axes = [
    { name: 'x' as const, value: [1, 0, 0] as Vec3 },
    { name: 'y' as const, value: [0, 1, 0] as Vec3 },
    { name: 'z' as const, value: [0, 0, 1] as Vec3 }
  ];
  axes.sort(
    (left, right) => Math.abs(Vec3Math.dot(left.value, z)) - Math.abs(Vec3Math.dot(right.value, z))
  );
  const up = axes[0]!;
  const x = Vec3Math.normalize(Vec3Math.cross(up.value, z));
  const y = Vec3Math.normalize(Vec3Math.cross(z, x));
  return Object.freeze({ x, y, z, upAxis: up.name });
}

export function buildStableCascade(input: {
  readonly cornersWorld: readonly Vec3[];
  readonly lightDirection: Vec3;
  readonly usableResolution: number;
  readonly casterDepthRange: Readonly<{ min: number; max: number }>;
  readonly radiusQuantum?: number;
}): StableCascade {
  if (input.cornersWorld.length !== 8 || input.cornersWorld.some((corner) => !finiteVec3(corner))) {
    throw new Error('Stable CSM requires exactly eight finite frustum corners.');
  }
  if (!Number.isSafeInteger(input.usableResolution) || input.usableResolution <= 0) {
    throw new Error('Stable CSM usable resolution must be a positive integer.');
  }
  if (
    !Number.isFinite(input.casterDepthRange.min) ||
    !Number.isFinite(input.casterDepthRange.max) ||
    input.casterDepthRange.max <= input.casterDepthRange.min
  ) {
    throw new Error('Stable CSM caster depth range must be finite and increasing.');
  }
  const centerWorld = average(input.cornersWorld);
  const rawRadius = Math.max(
    ...input.cornersWorld.map((corner) =>
      Math.hypot(corner[0] - centerWorld[0], corner[1] - centerWorld[1], corner[2] - centerWorld[2])
    )
  );
  if (rawRadius <= 0) throw new Error('Stable CSM frustum slice must have non-zero extent.');
  const radius = quantizeRadius(rawRadius, input.radiusQuantum);
  const basis = stableLightBasis(input.lightDirection);
  const centerLightSpace = transformBasis(basis, centerWorld);
  const worldUnitsPerTexel = (2 * radius) / input.usableResolution;
  const snappedCenterLightSpace: Vec3 = [
    snapShadowCoordinate(centerLightSpace[0], worldUnitsPerTexel),
    snapShadowCoordinate(centerLightSpace[1], worldUnitsPerTexel),
    centerLightSpace[2]
  ];
  return Object.freeze({
    centerWorld,
    rawRadius,
    radius,
    basis,
    centerLightSpace,
    snappedCenterLightSpace,
    worldUnitsPerTexel,
    boundsLightSpace: Object.freeze({
      left: snappedCenterLightSpace[0] - radius,
      right: snappedCenterLightSpace[0] + radius,
      bottom: snappedCenterLightSpace[1] - radius,
      top: snappedCenterLightSpace[1] + radius,
      near: input.casterDepthRange.min,
      far: input.casterDepthRange.max
    })
  });
}

function quantizeRadius(radius: number, quantum: number | undefined): number {
  if (quantum === undefined) return radius;
  if (!Number.isFinite(quantum) || quantum <= 0) {
    throw new Error('Stable CSM radius quantum must be positive and finite.');
  }
  const scaled = radius / quantum;
  const scaledTolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 8;
  const bucket = Math.ceil(scaled - scaledTolerance) * quantum;
  // A fixed ulp guard keeps the bucket conservative for translated corners that lost low bits.
  const guard = Number.EPSILON * Math.max(1, Math.abs(bucket)) * 8;
  return bucket + guard;
}

function transformBasis(basis: StableLightBasis, point: Vec3): Vec3 {
  return [Vec3Math.dot(basis.x, point), Vec3Math.dot(basis.y, point), Vec3Math.dot(basis.z, point)];
}

function unprojectPlane(inverse: ArrayLike<number>, depth: number): readonly Vec3[] {
  return [-1, 1].flatMap((y) =>
    [-1, 1].map((x) => {
      const px = inverse[0]! * x + inverse[4]! * y + inverse[8]! * depth + inverse[12]!;
      const py = inverse[1]! * x + inverse[5]! * y + inverse[9]! * depth + inverse[13]!;
      const pz = inverse[2]! * x + inverse[6]! * y + inverse[10]! * depth + inverse[14]!;
      const pw = inverse[3]! * x + inverse[7]! * y + inverse[11]! * depth + inverse[15]!;
      if (!Number.isFinite(pw) || Math.abs(pw) <= Number.EPSILON) {
        throw new Error('Directional CSM cannot unproject a frustum corner at infinity.');
      }
      return [px / pw, py / pw, pz / pw] as Vec3;
    })
  );
}

function lerp3(near: Vec3, far: Vec3, amount: number): Vec3 {
  return [
    near[0] + (far[0] - near[0]) * amount,
    near[1] + (far[1] - near[1]) * amount,
    near[2] + (far[2] - near[2]) * amount
  ];
}

function worldToShadowMatrix(cascade: StableCascade): number[] {
  const { basis, boundsLightSpace: bounds } = cascade;
  const view = new Float32Array([
    basis.x[0],
    basis.y[0],
    basis.z[0],
    0,
    basis.x[1],
    basis.y[1],
    basis.z[1],
    0,
    basis.x[2],
    basis.y[2],
    basis.z[2],
    0,
    0,
    0,
    0,
    1
  ]);
  const projection = new Float32Array([
    2 / (bounds.right - bounds.left),
    0,
    0,
    0,
    0,
    2 / (bounds.top - bounds.bottom),
    0,
    0,
    0,
    0,
    1 / (bounds.far - bounds.near),
    0,
    -(bounds.right + bounds.left) / (bounds.right - bounds.left),
    -(bounds.top + bounds.bottom) / (bounds.top - bounds.bottom),
    -bounds.near / (bounds.far - bounds.near),
    1
  ]);
  return Array.from(Mat4.multiply(projection, view));
}

function average(values: readonly Vec3[]): Vec3 {
  // Compensated sums keep a floating-origin translation from perturbing a symmetric slice center.
  return [
    compensatedSum(values, 0) / values.length,
    compensatedSum(values, 1) / values.length,
    compensatedSum(values, 2) / values.length
  ];
}

function compensatedSum(values: readonly Vec3[], axis: number): number {
  let sum = 0;
  let compensation = 0;
  for (const value of values) {
    const adjusted = value[axis]! - compensation;
    const next = sum + adjusted;
    compensation = next - sum - adjusted;
    sum = next;
  }
  return sum;
}

function finiteVec3(value: Vec3): boolean {
  return value.length === 3 && value.every(Number.isFinite);
}
