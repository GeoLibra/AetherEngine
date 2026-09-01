import { Vec3Math } from '../../../math';
import type { Vec3 } from '../../../math/types';
import type { PreparedLight } from '../types';

const UINT32_MAX = 0xffff_ffff;

/** Validates physical light properties, units, and ranges at trust boundaries. */
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

/**
 * Validates, defensively copies, and deterministically sorts prepared lights by entity ID.
 */
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
  if (light.kind === 'directional')
    return Object.freeze({
      entity: light.entity,
      payloadVersion: light.payloadVersion,
      kind: 'directional',
      direction: snapshotVec3(light.direction),
      illuminanceLux: light.illuminanceLux,
      colorLinear: snapshotVec3(light.colorLinear),
      enabled: light.enabled,
      layerMask: light.layerMask,
      castsShadow: light.castsShadow
    }) as PreparedLight;
  if (light.kind === 'point')
    return Object.freeze({
      entity: light.entity,
      payloadVersion: light.payloadVersion,
      kind: 'point',
      position: snapshotVec3(light.position),
      luminousIntensityCandela: light.luminousIntensityCandela,
      range: light.range,
      colorLinear: snapshotVec3(light.colorLinear),
      enabled: light.enabled,
      layerMask: light.layerMask,
      castsShadow: light.castsShadow
    }) as PreparedLight;
  return Object.freeze({
    entity: light.entity,
    payloadVersion: light.payloadVersion,
    kind: 'spot',
    position: snapshotVec3(light.position),
    direction: snapshotVec3(light.direction),
    luminousIntensityCandela: light.luminousIntensityCandela,
    range: light.range,
    innerRadians: light.innerRadians,
    outerRadians: light.outerRadians,
    colorLinear: snapshotVec3(light.colorLinear),
    enabled: light.enabled,
    layerMask: light.layerMask,
    castsShadow: light.castsShadow
  }) as PreparedLight;
}

function snapshotVec3(value: Vec3): Vec3 {
  return Object.freeze([value[0], value[1], value[2]]) as Vec3;
}

/** Normalizes a light direction vector, throwing if zero or non-finite. */
export function normalizedLightDirection(direction: Vec3): Vec3 {
  assertDirection(direction, 'Light direction');
  return Vec3Math.normalize(direction, 'Light direction');
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
