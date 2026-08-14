import type { Vec3 } from '../../math/types';
import type { PreparedLight } from './types';

const UINT32_MAX = 0xffff_ffff;

export function validatePreparedLight(light: PreparedLight): void {
  assertEntity(light.entity);
  assertNonNegativeInteger(light.payloadVersion, 'Light payloadVersion');
  assertVec3(light.colorLinear, 'Light linear color', true);
  assertUint32(light.layerMask, 'Light layerMask');
  if (light.kind === 'directional') {
    assertDirection(light.direction, 'Directional light direction');
    assertNonNegativeFinite(light.illuminanceLux, 'Directional illuminanceLux');
    return;
  }
  assertVec3(light.position, `${label(light.kind)} light position`);
  assertNonNegativeFinite(light.luminousIntensityCandela, `${label(light.kind)} intensity`);
  assertPositiveFinite(light.range, `${label(light.kind)} range`);
  if (light.kind === 'spot') {
    assertDirection(light.direction, 'Spot light direction');
    if (
      !Number.isFinite(light.innerRadians) ||
      !Number.isFinite(light.outerRadians) ||
      light.innerRadians < 0 ||
      light.innerRadians > light.outerRadians ||
      light.outerRadians >= Math.PI / 2
    ) {
      throw new Error('Spot light angles must satisfy 0 <= inner <= outer < PI/2.');
    }
  }
}

export function orderLightsForGpu(lights: readonly PreparedLight[]): readonly PreparedLight[] {
  for (const light of lights) validatePreparedLight(light);
  const ordered = lights
    .map(snapshotPreparedLight)
    .sort((left, right) => left.entity - right.entity);
  for (let index = 1; index < ordered.length; index++) {
    if (ordered[index - 1]!.entity === ordered[index]!.entity) {
      throw new Error(`Duplicate prepared light entity ${ordered[index]!.entity}.`);
    }
  }
  return Object.freeze(ordered);
}

function snapshotPreparedLight(light: PreparedLight): PreparedLight {
  const common = {
    ...light,
    colorLinear: Object.freeze([...light.colorLinear]) as Vec3
  };
  if (light.kind === 'directional')
    return Object.freeze({
      ...common,
      direction: Object.freeze([...light.direction]) as Vec3
    }) as PreparedLight;
  if (light.kind === 'point')
    return Object.freeze({
      ...common,
      position: Object.freeze([...light.position]) as Vec3
    }) as PreparedLight;
  return Object.freeze({
    ...common,
    position: Object.freeze([...light.position]) as Vec3,
    direction: Object.freeze([...light.direction]) as Vec3
  }) as PreparedLight;
}

export function normalizedLightDirection(direction: Vec3): Vec3 {
  assertDirection(direction, 'Light direction');
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  return [direction[0] / length, direction[1] / length, direction[2] / length];
}

function assertDirection(value: Vec3, name: string): void {
  assertVec3(value, name);
  if (Math.hypot(value[0], value[1], value[2]) <= 1e-12) {
    throw new Error(`${name} must be non-zero.`);
  }
}

function assertVec3(value: Vec3, name: string, nonNegative = false): void {
  if (
    value.length !== 3 ||
    value.some((component) => !Number.isFinite(component) || (nonNegative && component < 0))
  ) {
    throw new Error(
      `${name} must contain three ${nonNegative ? 'non-negative ' : ''}finite values.`
    );
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`${name} must be non-negative and finite.`);
}

function assertPositiveFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0)
    throw new Error(`${name} must be positive and finite.`);
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`${name} must be a non-negative integer.`);
}

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    throw new Error(`${name} must be an unsigned 32-bit integer.`);
  }
}

function assertEntity(value: number): void {
  assertNonNegativeInteger(value, 'Light entity');
}

function label(kind: 'point' | 'spot'): string {
  return kind === 'point' ? 'Point' : 'Spot';
}
