import { defineObjectComponent } from '../../ecs/component';
import type { MeshBounds } from '../../geometry';
import { MaterialAssetType, MeshAssetType, validateAssetHandle } from '../../assets';
import type {
  AssetTypeId,
  GeometryMeshAsset,
  MaterialAssetPayload,
  ResolvedAssetReference
} from '../../assets/types';
import type { MeshRenderSourceView, RenderMaterialBinding } from './types';

/** Sparse MainWorld component containing render-ready mesh and material identities. */
export const MeshRenderSource = defineObjectComponent<MeshRenderSourceView>({
  id: 'aether.rendering.mesh-source',
  version: 2,
  name: 'MeshRenderSource',
  fields: [
    field('mesh', {
      kind: 'struct',
      fields: [
        field('handle', {
          kind: 'struct',
          fields: [field('assetId', { kind: 'string' }), field('type', { kind: 'string' })]
        }),
        field('payloadVersion', { kind: 'number', format: 'u32' })
      ]
    }),
    field('submesh', { kind: 'number', format: 'u32' }),
    field('materials', {
      kind: 'array',
      element: {
        kind: 'struct',
        fields: [
          field('slot', { kind: 'number', format: 'u32' }),
          field('handle', {
            kind: 'struct',
            fields: [field('assetId', { kind: 'string' }), field('type', { kind: 'string' })]
          }),
          field('payloadVersion', { kind: 'number', format: 'u32' })
        ]
      }
    }),
    field('localBounds', {
      kind: 'struct',
      fields: [
        field('aabb', {
          kind: 'struct',
          fields: [
            field('min', { kind: 'vector', length: 3 }),
            field('max', { kind: 'vector', length: 3 })
          ]
        }),
        field('sphere', {
          kind: 'struct',
          fields: [
            field('center', { kind: 'vector', length: 3 }),
            field('radius', { kind: 'number', format: 'f32' })
          ]
        })
      ]
    }),
    field('visible', { kind: 'boolean' }),
    field('layerMask', { kind: 'number', format: 'u32' })
  ],
  validate(input) {
    if (!isRecord(input)) return invalid('MeshRenderSource must be an object.');
    try {
      const mesh = validateAssetReference<GeometryMeshAsset>(input.mesh, MeshAssetType, 'mesh');
      const submesh = requireUint(input.submesh, 'submesh');
      if (!Array.isArray(input.materials)) throw new Error('materials must be an array.');
      const materials = input.materials.map((value, index) =>
        validateMaterialBinding(value, index)
      );
      const slots = new Set(materials.map((binding) => binding.slot));
      if (slots.size !== materials.length) throw new Error('material slots must be unique.');
      const localBounds = validateBounds(input.localBounds);
      if (typeof input.visible !== 'boolean') throw new Error('visible must be boolean.');
      const layerMask = requireUint(input.layerMask, 'layerMask');
      return {
        ok: true,
        value: { mesh, submesh, materials, localBounds, visible: input.visible, layerMask }
      };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'Invalid MeshRenderSource.');
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
    serialization: 'runtime-only' as const
  };
}

function validateAssetReference<T>(
  value: unknown,
  type: AssetTypeId<T>,
  label: string
): ResolvedAssetReference<T> {
  if (!isRecord(value)) throw new Error(`${label} reference must be an object.`);
  return {
    handle: validateAssetHandle(value.handle, type, label),
    payloadVersion: requireUint(value.payloadVersion, `${label} payloadVersion`)
  };
}

function validateMaterialBinding(value: unknown, index: number): RenderMaterialBinding {
  const asset = validateAssetReference<MaterialAssetPayload>(
    value,
    MaterialAssetType,
    `materials[${index}]`
  );
  return {
    ...asset,
    slot: requireUint((value as Record<string, unknown>).slot, `materials[${index}].slot`)
  };
}

function validateBounds(value: unknown): MeshBounds {
  if (!isRecord(value) || !isRecord(value.aabb) || !isRecord(value.sphere)) {
    throw new Error('localBounds must contain AABB and sphere records.');
  }
  const min = vector3(value.aabb.min, 'localBounds.aabb.min');
  const max = vector3(value.aabb.max, 'localBounds.aabb.max');
  if (min.some((entry, axis) => entry > max[axis]!))
    throw new Error('localBounds AABB is inverted.');
  const center = vector3(value.sphere.center, 'localBounds.sphere.center');
  const radius = value.sphere.radius;
  if (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0) {
    throw new Error('localBounds sphere radius must be finite and non-negative.');
  }
  return { aabb: { min, max }, sphere: { center, radius } };
}

function vector3(value: unknown, label: string): [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
  ) {
    throw new Error(`${label} must contain three finite numbers.`);
  }
  return [value[0], value[1], value[2]];
}

function requireUint(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new Error(`${label} must be a non-negative safe integer.`);
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function invalid(message: string) {
  return { ok: false as const, issues: [{ path: [], message }] };
}
