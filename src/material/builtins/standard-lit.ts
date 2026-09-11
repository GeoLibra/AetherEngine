import { createMaterialAsset, createMaterialInstance, resolveMaterialAsset } from '../asset';
import { defineMaterialSchema } from '../schema';
import { createMaterialTechniqueRole } from '../technique';
import type {
  MaterialAsset,
  MaterialInstance,
  MaterialSamplerReference,
  MaterialTextureReference,
  ResolvedMaterialAsset
} from '../types';
import {
  STANDARD_LIT_SHADER_ABI_VERSION,
  STANDARD_LIT_SHADER_ARTIFACT
} from '../../shader/builtins';
import { createCookedShaderBindingManifest } from '../../shader/layout';

export const STANDARD_LIT_SHADER_MODULE_KEY = 'aether.shader.standard-lit.v2';
export const STANDARD_LIT_BINDING_LAYOUT_HASH = createCookedShaderBindingManifest(
  STANDARD_LIT_SHADER_ARTIFACT,
  STANDARD_LIT_SHADER_ABI_VERSION
).layoutHash;
export const STANDARD_LIT_FORWARD_ROLE = createMaterialTechniqueRole('standard-forward');

/** Canonical parameter schema for the baseline standard-lit material. */
const texture = (assetId: string): MaterialTextureReference =>
  Object.freeze({ kind: 'texture', assetId });
const sampler = (assetId: string): MaterialSamplerReference =>
  Object.freeze({ kind: 'sampler', assetId });

export const StandardLitMaterialSchema = defineMaterialSchema({
  id: 'aether.material.standard-lit.schema',
  version: 2,
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
    },
    emissiveFactor: {
      fieldId: 'emissive-factor',
      name: 'emissiveFactor',
      valueType: { kind: 'vector', length: 3, format: 'f32' },
      defaultValue: [0, 0, 0],
      bindingPath: 'material.emissiveFactor'
    },
    normalScale: {
      fieldId: 'normal-scale',
      name: 'normalScale',
      valueType: { kind: 'number', format: 'f32' },
      defaultValue: 1,
      bindingPath: 'material.normalScale'
    },
    occlusionStrength: {
      fieldId: 'occlusion-strength',
      name: 'occlusionStrength',
      valueType: { kind: 'number', format: 'f32' },
      defaultValue: 1,
      bindingPath: 'material.occlusionStrength'
    },
    alphaCutoff: {
      fieldId: 'alpha-cutoff',
      name: 'alphaCutoff',
      valueType: { kind: 'number', format: 'f32' },
      defaultValue: 0.5,
      bindingPath: 'material.alphaCutoff'
    },
    baseColorTexture: textureField(
      'base-color-texture',
      'baseColorTexture',
      'aether.texture.white-srgb',
      'material.baseColorTexture'
    ),
    metallicRoughnessTexture: textureField(
      'metallic-roughness-texture',
      'metallicRoughnessTexture',
      'aether.texture.white-data',
      'material.metallicRoughnessTexture'
    ),
    normalTexture: textureField(
      'normal-texture',
      'normalTexture',
      'aether.texture.flat-normal',
      'material.normalTexture'
    ),
    occlusionTexture: textureField(
      'occlusion-texture',
      'occlusionTexture',
      'aether.texture.white-data',
      'material.occlusionTexture'
    ),
    emissiveTexture: textureField(
      'emissive-texture',
      'emissiveTexture',
      'aether.texture.black-srgb',
      'material.emissiveTexture'
    ),
    sampler: {
      fieldId: 'surface-sampler',
      name: 'sampler',
      valueType: { kind: 'sampler-reference' },
      defaultValue: sampler('aether.sampler.linear-repeat'),
      bindingPath: 'material.surfaceSampler'
    },
    baseColorUvSet: uvField('base-color-uv-set', 'baseColorUvSet'),
    metallicRoughnessUvSet: uvField('metallic-roughness-uv-set', 'metallicRoughnessUvSet'),
    normalUvSet: uvField('normal-uv-set', 'normalUvSet'),
    occlusionUvSet: uvField('occlusion-uv-set', 'occlusionUvSet'),
    emissiveUvSet: uvField('emissive-uv-set', 'emissiveUvSet')
  }
});

export type StandardLitAlphaMode = 'opaque' | 'mask';
export interface StandardLitUvSets {
  readonly baseColor?: 0 | 1;
  readonly metallicRoughness?: 0 | 1;
  readonly normal?: 0 | 1;
  readonly occlusion?: 0 | 1;
  readonly emissive?: 0 | 1;
}

export interface StandardLitMaterialOptions {
  readonly baseColor?: readonly [number, number, number, number];
  readonly metallic?: number;
  readonly roughness?: number;
  readonly emissiveFactor?: readonly [number, number, number];
  readonly normalScale?: number;
  readonly occlusionStrength?: number;
  readonly alphaMode?: StandardLitAlphaMode;
  readonly alphaCutoff?: number;
  readonly doubleSided?: boolean;
  readonly baseColorTexture?: MaterialTextureReference;
  readonly metallicRoughnessTexture?: MaterialTextureReference;
  readonly normalTexture?: MaterialTextureReference;
  readonly occlusionTexture?: MaterialTextureReference;
  readonly emissiveTexture?: MaterialTextureReference;
  readonly sampler?: MaterialSamplerReference;
  readonly uvSets?: StandardLitUvSets;
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
  const emissiveFactor = nonNegativeVector(options.emissiveFactor ?? [0, 0, 0], 'emissiveFactor');
  const normalScale = nonNegative(options.normalScale ?? 1, 'normalScale');
  const occlusionStrength = normalized(options.occlusionStrength ?? 1, 'occlusionStrength');
  const alphaCutoff = normalized(options.alphaCutoff ?? 0.5, 'alphaCutoff');
  const alphaMode = options.alphaMode ?? 'opaque';
  const asset = createMaterialAsset({
    id: 'aether.material.standard-lit',
    version: 2,
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
          requiredMeshCapabilities: ['normal', 'uv0', 'uv1', 'tangent'],
          attachmentFormats: ['bgra8unorm', 'rgba8unorm'],
          depthStencilFormats: ['depth24plus'],
          sampleCounts: [1]
        }
      }
    ],
    renderState: {
      surface: alphaMode === 'mask' ? 'alpha-mask' : 'opaque',
      depthTest: true,
      depthWrite: true,
      cullMode: options.doubleSided === true ? 'none' : 'back'
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
    draft.set(StandardLitMaterialSchema.fields.emissiveFactor, emissiveFactor);
    draft.set(StandardLitMaterialSchema.fields.normalScale, normalScale);
    draft.set(StandardLitMaterialSchema.fields.occlusionStrength, occlusionStrength);
    draft.set(StandardLitMaterialSchema.fields.alphaCutoff, alphaCutoff);
    draft.set(
      StandardLitMaterialSchema.fields.baseColorTexture,
      options.baseColorTexture ?? texture('aether.texture.white-srgb')
    );
    draft.set(
      StandardLitMaterialSchema.fields.metallicRoughnessTexture,
      options.metallicRoughnessTexture ?? texture('aether.texture.white-data')
    );
    draft.set(
      StandardLitMaterialSchema.fields.normalTexture,
      options.normalTexture ?? texture('aether.texture.flat-normal')
    );
    draft.set(
      StandardLitMaterialSchema.fields.occlusionTexture,
      options.occlusionTexture ?? texture('aether.texture.white-data')
    );
    draft.set(
      StandardLitMaterialSchema.fields.emissiveTexture,
      options.emissiveTexture ?? texture('aether.texture.black-srgb')
    );
    draft.set(
      StandardLitMaterialSchema.fields.sampler,
      options.sampler ?? sampler('aether.sampler.linear-repeat')
    );
    draft.set(StandardLitMaterialSchema.fields.baseColorUvSet, options.uvSets?.baseColor ?? 0);
    draft.set(
      StandardLitMaterialSchema.fields.metallicRoughnessUvSet,
      options.uvSets?.metallicRoughness ?? 0
    );
    draft.set(StandardLitMaterialSchema.fields.normalUvSet, options.uvSets?.normal ?? 0);
    draft.set(StandardLitMaterialSchema.fields.occlusionUvSet, options.uvSets?.occlusion ?? 0);
    draft.set(StandardLitMaterialSchema.fields.emissiveUvSet, options.uvSets?.emissive ?? 0);
  });
  return Object.freeze({ asset, resolved, instance }) as StandardLitMaterial;
}

function textureField(fieldId: string, name: string, assetId: string, bindingPath: string) {
  return {
    fieldId,
    name,
    valueType: { kind: 'texture-reference' } as const,
    defaultValue: texture(assetId),
    bindingPath
  };
}

function uvField(fieldId: string, name: string) {
  return {
    fieldId,
    name,
    valueType: { kind: 'number', format: 'u32' } as const,
    defaultValue: 0,
    bindingPath: `material.${name}`
  };
}

function nonNegative(value: number, field: 'normalScale'): number {
  if (!Number.isFinite(value) || value < 0)
    throw new Error(`Standard-lit ${field} must contain finite non-negative values.`);
  return value;
}

function nonNegativeVector(
  value: readonly number[],
  field: 'emissiveFactor'
): readonly [number, number, number] {
  if (value.length !== 3 || value.some((entry) => !Number.isFinite(entry) || entry < 0)) {
    throw new Error(`Standard-lit ${field} must contain finite non-negative values.`);
  }
  return Object.freeze([value[0]!, value[1]!, value[2]!]);
}

function normalized(
  value: number,
  field: 'metallic' | 'roughness' | 'occlusionStrength' | 'alphaCutoff'
): number {
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
