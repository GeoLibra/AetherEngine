import { createMaterialAsset, createMaterialInstance, resolveMaterialAsset } from '../asset';
import { defineMaterialSchema } from '../schema';
import { createMaterialTechniqueRole } from '../technique';
import type { MaterialAsset, MaterialInstance, ResolvedMaterialAsset } from '../types';
import { STANDARD_LIT_SHADER_ABI_VERSION, STANDARD_LIT_SHADER_MODULE } from '../../shader/builtins';
import { createShaderBindingManifest } from '../../shader/layout';

export const STANDARD_LIT_SHADER_MODULE_KEY = 'aether.shader.standard-lit.v2';
export const STANDARD_LIT_BINDING_LAYOUT_HASH = createShaderBindingManifest(
  STANDARD_LIT_SHADER_MODULE,
  STANDARD_LIT_SHADER_ABI_VERSION
).layoutHash;
export const STANDARD_LIT_FORWARD_ROLE = createMaterialTechniqueRole('standard-forward');

/** Canonical parameter schema for the baseline standard-lit material. */
export const StandardLitMaterialSchema = defineMaterialSchema({
  id: 'aether.material.standard-lit.schema',
  version: 1,
  fields: {
    baseColor: {
      fieldId: 'base-color',
      name: 'baseColor',
      valueType: { kind: 'vector', length: 4, format: 'f32' },
      defaultValue: [1, 1, 1, 1],
      bindingPath: 'material.baseColor'
    },
    metallic: {
      fieldId: 'metallic',
      name: 'metallic',
      valueType: { kind: 'number', format: 'f32' },
      defaultValue: 0,
      bindingPath: 'material.metallic'
    },
    roughness: {
      fieldId: 'roughness',
      name: 'roughness',
      valueType: { kind: 'number', format: 'f32' },
      defaultValue: 0.5,
      bindingPath: 'material.roughness'
    }
  }
});

export interface StandardLitMaterialOptions {
  readonly baseColor?: readonly [number, number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
}

/** Immutable built-in asset ownership bundle returned to renderer composition. */
export interface StandardLitMaterial {
  readonly asset: MaterialAsset;
  readonly resolved: ResolvedMaterialAsset;
  readonly instance: MaterialInstance;
}

/**
 * Creates one standard-lit material instance using normalized linear surface parameters.
 *
 * @throws When base color, metallic, or roughness contains a non-finite or out-of-range value.
 */
export function createStandardLitMaterial(
  options: StandardLitMaterialOptions = {}
): StandardLitMaterial {
  const baseColor = normalizedVector(options.baseColor ?? [1, 1, 1, 1], 'baseColor');
  const metallic = normalized(options.metallic ?? 0, 'metallic');
  const roughness = normalized(options.roughness ?? 0.5, 'roughness');
  const asset = createMaterialAsset({
    id: 'aether.material.standard-lit',
    version: 1,
    schema: StandardLitMaterialSchema,
    techniques: [
      {
        name: 'standard-lit-forward',
        passRole: STANDARD_LIT_FORWARD_ROLE,
        shader: {
          moduleKey: STANDARD_LIT_SHADER_MODULE_KEY,
          vertexEntry: 'standardLitVertex',
          fragmentEntry: 'standardLitFragment'
        },
        priority: 0,
        compatibility: {
          semanticTag: 'standard-lit',
          bindingLayoutHash: STANDARD_LIT_BINDING_LAYOUT_HASH,
          requiredFeatures: [],
          requiredMaterialFeatures: [],
          requiredViewFeatures: [],
          requiredMeshCapabilities: ['normal'],
          attachmentFormats: ['bgra8unorm', 'rgba8unorm'],
          depthStencilFormats: ['depth24plus'],
          sampleCounts: [1]
        }
      }
    ],
    renderState: {
      surface: 'opaque',
      depthTest: true,
      depthWrite: true,
      cullMode: 'back'
    }
  });
  const resolved = resolveMaterialAsset(
    { assetId: asset.id, payloadVersion: asset.version },
    asset
  );
  const instance = createMaterialInstance(resolved).edit((draft) => {
    draft.set(StandardLitMaterialSchema.fields.baseColor, baseColor);
    draft.set(StandardLitMaterialSchema.fields.metallic, metallic);
    draft.set(StandardLitMaterialSchema.fields.roughness, roughness);
  });
  return Object.freeze({ asset, resolved, instance }) as StandardLitMaterial;
}

function normalized(value: number, field: 'metallic' | 'roughness'): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Standard-lit ${field} must contain finite normalized values.`);
  }
  return value;
}

function normalizedVector(
  value: readonly number[],
  field: 'baseColor'
): readonly [number, number, number, number] {
  if (
    value.length !== 4 ||
    value.some((entry) => !Number.isFinite(entry) || entry < 0 || entry > 1)
  ) {
    throw new Error(`Standard-lit ${field} must contain finite normalized values.`);
  }
  return Object.freeze([value[0]!, value[1]!, value[2]!, value[3]!]);
}
