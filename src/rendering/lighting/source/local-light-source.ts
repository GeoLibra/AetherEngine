import { isRecord } from '../../../core';
import { defineObjectComponent } from '../../../ecs/component';
import { normalizedLightDirection } from '../core/light';
import type { PointLightSourceView, SpotLightSourceView } from '../types';

const UINT32_MAX = 0xffff_ffff;

/** ECS source for a finite omnidirectional point light. Positions use world-space meters. */
export const PointLightSource = defineObjectComponent<PointLightSourceView>({
  id: 'aether.rendering.point-light-source',
  version: 1,
  name: 'PointLightSource',
  fields: commonFields('position'),
  validate(input) {
    if (!isRecord(input)) return invalid('PointLightSource must be an object.');
    try {
      return { ok: true, value: point(input) };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'Invalid PointLightSource.');
    }
  }
});

/** ECS source for a finite spot light. Direction is normalized at the trust boundary. */
export const SpotLightSource = defineObjectComponent<SpotLightSourceView>({
  id: 'aether.rendering.spot-light-source',
  version: 1,
  name: 'SpotLightSource',
  fields: [
    ...commonFields('position'),
    field('direction', { kind: 'vector', length: 3 }),
    field('innerRadians', { kind: 'number', format: 'f32' }),
    field('outerRadians', { kind: 'number', format: 'f32' })
  ],
  validate(input) {
    if (!isRecord(input)) return invalid('SpotLightSource must be an object.');
    try {
      const base = point(input);
      const direction = normalizedLightDirection(vector3(input.direction, 'direction'));
      const innerRadians = nonNegative(input.innerRadians, 'innerRadians');
      const outerRadians = nonNegative(input.outerRadians, 'outerRadians');
      if (innerRadians > outerRadians || outerRadians >= Math.PI / 2)
        throw new Error('Spot light angles must satisfy 0 <= inner <= outer < PI/2.');
      return { ok: true, value: { ...base, direction, innerRadians, outerRadians } };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'Invalid SpotLightSource.');
    }
  }
});

function point(input: Record<string, unknown>): PointLightSourceView {
  return {
    position: vector3(input.position, 'position'),
    colorLinear: nonNegativeVec3(input.colorLinear, 'colorLinear'),
    luminousIntensityCandela: nonNegative(
      input.luminousIntensityCandela,
      'luminousIntensityCandela'
    ),
    range: positive(input.range, 'range'),
    enabled: boolean(input.enabled, 'enabled'),
    layerMask: uint32(input.layerMask, 'layerMask'),
    castsShadow: boolean(input.castsShadow, 'castsShadow')
  };
}
function commonFields(positionName: string) {
  return [
    field(positionName, { kind: 'vector', length: 3 }),
    field('colorLinear', { kind: 'vector', length: 3 }),
    field('luminousIntensityCandela', { kind: 'number', format: 'f32' }),
    field('range', { kind: 'number', format: 'f32' }),
    field('enabled', { kind: 'boolean' }),
    field('layerMask', { kind: 'number', format: 'u32' }),
    field('castsShadow', { kind: 'boolean' })
  ];
}
function field(
  name: string,
  type: Parameters<typeof defineObjectComponent>[0]['fields'][number]['type']
) {
  return {
    id: name,
    name,
    type,
    required: true,
    compare: 'exact' as const,
    serialization: 'save' as const
  };
}
function vector3(value: unknown, label: string): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((x) => typeof x !== 'number' || !Number.isFinite(x))
  )
    throw new Error(`Local light ${label} must contain three finite values.`);
  return [value[0], value[1], value[2]];
}
function nonNegativeVec3(value: unknown, label: string): readonly [number, number, number] {
  const result = vector3(value, label);
  if (result.some((x) => x < 0)) throw new Error(`Local light ${label} must be non-negative.`);
  return result;
}
function positive(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    throw new Error(`Local light ${label} must be positive and finite.`);
  return value;
}
function nonNegative(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
    throw new Error(`Local light ${label} must be non-negative and finite.`);
  return value;
}
function boolean(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Local light ${label} must be boolean.`);
  return value;
}
function uint32(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > UINT32_MAX)
    throw new Error(`Local light ${label} must be an unsigned 32-bit integer.`);
  return value as number;
}
function invalid(message: string) {
  return { ok: false as const, issues: [{ path: [], message }] };
}
