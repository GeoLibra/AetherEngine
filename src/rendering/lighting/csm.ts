import type { Vec3 } from '../../math/types';
import { normalizedLightDirection } from './light';

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
  axes.sort((left, right) => Math.abs(dot(left.value, z)) - Math.abs(dot(right.value, z)));
  const up = axes[0]!;
  const x = normalize(cross(up.value, z));
  const y = normalize(cross(z, x));
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
  return [dot(basis.x, point), dot(basis.y, point), dot(basis.z, point)];
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

function cross(left: Vec3, right: Vec3): Vec3 {
  return [
    left[1] * right[2] - left[2] * right[1],
    left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]
  ];
}

function normalize(value: Vec3): Vec3 {
  const length = Math.hypot(value[0], value[1], value[2]);
  return [value[0] / length, value[1] / length, value[2] / length];
}

function dot(left: Vec3, right: Vec3): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function finiteVec3(value: Vec3): boolean {
  return value.length === 3 && value.every(Number.isFinite);
}
