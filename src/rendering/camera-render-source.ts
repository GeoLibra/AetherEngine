import { defineObjectComponent } from '../ecs/component';
import { validateCameraProjection } from './camera';
import type { CameraRenderSourceView } from './types';

/** Sparse MainWorld camera intent; surface and FeaturePolicy remain composition-owned. */
export const CameraRenderSource = defineObjectComponent<CameraRenderSourceView>({
  id: 'aether.rendering.camera-source',
  version: 1,
  name: 'CameraRenderSource',
  fields: [
    field('projection', {
      kind: 'struct',
      fields: [
        nestedField('kind', { kind: 'enum', values: ['perspective', 'orthographic'] }),
        nestedField('near', { kind: 'number', format: 'f32' }),
        nestedField('far', { kind: 'number', format: 'f32' }),
        nestedField('verticalFovRadians', { kind: 'number', format: 'f32' }, false),
        nestedField('orthographicHalfHeight', { kind: 'number', format: 'f32' }, false)
      ]
    }),
    field('viewportRect', {
      kind: 'struct',
      fields: ['x', 'y', 'width', 'height'].map((name) =>
        nestedField(name, { kind: 'number', format: 'f32' })
      )
    }),
    field('layerMask', { kind: 'number', format: 'u32' }),
    field('depthMode', { kind: 'enum', values: ['standard', 'reverse'] }),
    field('historyKey', { kind: 'string' })
  ],
  validate(input) {
    if (!isRecord(input)) return invalid('CameraRenderSource must be an object.');
    try {
      const projection = input.projection as CameraRenderSourceView['projection'];
      validateCameraProjection(projection);
      if (projection.far === 'infinite') {
        throw new Error('CameraRenderSource automatic projection currently requires finite far.');
      }
      const rect = input.viewportRect;
      if (!isRecord(rect)) throw new Error('Camera viewportRect must be an object.');
      const viewportRect = {
        x: finite(rect.x, 'viewportRect.x'),
        y: finite(rect.y, 'viewportRect.y'),
        width: finite(rect.width, 'viewportRect.width'),
        height: finite(rect.height, 'viewportRect.height')
      };
      if (
        viewportRect.x < 0 ||
        viewportRect.y < 0 ||
        viewportRect.width < 0 ||
        viewportRect.height < 0 ||
        viewportRect.x + viewportRect.width > 1 ||
        viewportRect.y + viewportRect.height > 1
      )
        throw new Error('Camera viewportRect must remain within normalized [0, 1].');
      const layerMask = uint(input.layerMask, 'layerMask');
      if (input.depthMode !== 'standard' && input.depthMode !== 'reverse') {
        throw new Error('Camera depthMode must be standard or reverse.');
      }
      if (typeof input.historyKey !== 'string' || !input.historyKey.trim()) {
        throw new Error('Camera historyKey must be non-empty.');
      }
      return {
        ok: true,
        value: {
          projection,
          viewportRect,
          layerMask,
          depthMode: input.depthMode,
          historyKey: input.historyKey
        }
      };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'Invalid CameraRenderSource.');
    }
  }
});

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
function nestedField(
  name: string,
  type: Parameters<typeof defineObjectComponent>[0]['fields'][number]['type'],
  required = true
) {
  return {
    id: name,
    name,
    type,
    required,
    compare: 'exact' as const,
    serialization: 'save' as const
  };
}
function finite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`Camera ${label} must be finite.`);
  return value;
}
function uint(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffffffff) {
    throw new Error(`Camera ${label} must be an unsigned 32-bit integer.`);
  }
  return value as number;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
function invalid(message: string) {
  return { ok: false as const, issues: [{ path: [], message }] };
}
