import { createMaterialAsset, createMaterialInstance, resolveMaterialAsset } from '../asset';
import { defineMaterialSchema } from '../schema';
import {
  createMaterialSamplerReference,
  createMaterialTextureReference,
  defineOffsetField,
  defineTextureField,
  defineTransformField,
  defineUvField
} from '../schema-helpers';
import { createMaterialTechniqueRole } from '../technique';
import {
  assertNonNegativeScalar,
  assertNonNegativeVector,
  assertNormalizedScalar,
  assertNormalizedVector
} from '../validation';
import type {
  StandardLitAlphaMode,
  StandardLitMaterial,
  StandardLitMaterialOptions,
  StandardLitSamplers,
  StandardLitTextureTransforms,
  StandardLitUvSets,
  TextureUvAffineTransform
} from '../types';
import {
  STANDARD_LIT_SHADER_ABI_VERSION,
  STANDARD_LIT_SHADER_ARTIFACT
} from '../../shader/builtins';
import { createCookedShaderBindingManifest } from '../../shader/layout';

export type {
  StandardLitAlphaMode,
  StandardLitMaterial,
  StandardLitMaterialOptions,
  StandardLitSamplers,
  StandardLitTextureTransforms,
  StandardLitUvSets,
  TextureUvAffineTransform
};

export const STANDARD_LIT_SHADER_MODULE_KEY = 'aether.shader.standard-lit.v2';
export const STANDARD_LIT_BINDING_LAYOUT_HASH = createCookedShaderBindingManifest(
  STANDARD_LIT_SHADER_ARTIFACT,
  STANDARD_LIT_SHADER_ABI_VERSION
).layoutHash;
export const STANDARD_LIT_FORWARD_ROLE = createMaterialTechniqueRole('standard-forward');

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
    baseColorTexture: defineTextureField(
      'base-color-texture',
      'baseColorTexture',
      'aether.texture.white-srgb',
      'material.baseColorTexture'
    ),
    metallicRoughnessTexture: defineTextureField(
      'metallic-roughness-texture',
      'metallicRoughnessTexture',
      'aether.texture.white-data',
      'material.metallicRoughnessTexture'
    ),
    normalTexture: defineTextureField(
      'normal-texture',
      'normalTexture',
      'aether.texture.flat-normal',
      'material.normalTexture'
    ),
    occlusionTexture: defineTextureField(
      'occlusion-texture',
      'occlusionTexture',
      'aether.texture.white-data',
      'material.occlusionTexture'
    ),
    emissiveTexture: defineTextureField(
      'emissive-texture',
      'emissiveTexture',
      'aether.texture.black-srgb',
      'material.emissiveTexture'
    ),
    sampler: {
      fieldId: 'surface-sampler',
      name: 'sampler',
      valueType: { kind: 'sampler-reference' },
      defaultValue: createMaterialSamplerReference('aether.sampler.linear-repeat'),
      bindingPath: 'material.surfaceSampler'
    },
    baseColorUvSet: defineUvField('base-color-uv-set', 'baseColorUvSet'),
    metallicRoughnessUvSet: defineUvField('metallic-roughness-uv-set', 'metallicRoughnessUvSet'),
    normalUvSet: defineUvField('normal-uv-set', 'normalUvSet'),
    occlusionUvSet: defineUvField('occlusion-uv-set', 'occlusionUvSet'),
    emissiveUvSet: defineUvField('emissive-uv-set', 'emissiveUvSet'),
    baseColorTransform: defineTransformField('base-color-transform', 'baseColorTransform'),
    baseColorOffset: defineOffsetField('base-color-offset', 'baseColorOffset'),
    metallicRoughnessTransform: defineTransformField(
      'metallic-roughness-transform',
      'metallicRoughnessTransform'
    ),
    metallicRoughnessOffset: defineOffsetField(
      'metallic-roughness-offset',
      'metallicRoughnessOffset'
    ),
    normalTransform: defineTransformField('normal-transform', 'normalTransform'),
    normalOffset: defineOffsetField('normal-offset', 'normalOffset'),
    occlusionTransform: defineTransformField('occlusion-transform', 'occlusionTransform'),
    occlusionOffset: defineOffsetField('occlusion-offset', 'occlusionOffset'),
    emissiveTransform: defineTransformField('emissive-transform', 'emissiveTransform'),
    emissiveOffset: defineOffsetField('emissive-offset', 'emissiveOffset')
  }
});

/**
 * Creates one standard-lit material instance using normalized linear surface parameters.
 *
 * @throws When base color, metallic, or roughness contains a non-finite or out-of-range value.
 */
export function createStandardLitMaterial(
  options: StandardLitMaterialOptions = {}
): StandardLitMaterial {
  const baseColor = assertNormalizedVector(
    options.baseColor ?? [1, 1, 1, 1],
    4,
    'baseColor'
  ) as readonly [number, number, number, number];
  const metallic = assertNormalizedScalar(options.metallic ?? 0, 'metallic');
  const roughness = assertNormalizedScalar(options.roughness ?? 0.5, 'roughness');
  const emissiveFactor = assertNonNegativeVector(
    options.emissiveFactor ?? [0, 0, 0],
    3,
    'emissiveFactor'
  ) as readonly [number, number, number];
  const normalScale = assertNonNegativeScalar(options.normalScale ?? 1, 'normalScale');
  const occlusionStrength = assertNormalizedScalar(
    options.occlusionStrength ?? 1,
    'occlusionStrength'
  );
  const alphaCutoff = assertNormalizedScalar(options.alphaCutoff ?? 0.5, 'alphaCutoff');
  const alphaMode = options.alphaMode ?? 'opaque';
  const surface =
    alphaMode === 'mask' ? 'alpha-mask' : alphaMode === 'blend' ? 'transparent' : 'opaque';
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
      surface,
      depthTest: true,
      depthWrite: alphaMode !== 'blend',
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
      options.baseColorTexture ?? createMaterialTextureReference('aether.texture.white-srgb')
    );
    draft.set(
      StandardLitMaterialSchema.fields.metallicRoughnessTexture,
      options.metallicRoughnessTexture ??
        createMaterialTextureReference('aether.texture.white-data')
    );
    draft.set(
      StandardLitMaterialSchema.fields.normalTexture,
      options.normalTexture ?? createMaterialTextureReference('aether.texture.flat-normal')
    );
    draft.set(
      StandardLitMaterialSchema.fields.occlusionTexture,
      options.occlusionTexture ?? createMaterialTextureReference('aether.texture.white-data')
    );
    draft.set(
      StandardLitMaterialSchema.fields.emissiveTexture,
      options.emissiveTexture ?? createMaterialTextureReference('aether.texture.black-srgb')
    );
    const primarySampler =
      options.sampler ??
      options.samplers?.baseColor ??
      options.samplers?.metallicRoughness ??
      options.samplers?.normal ??
      options.samplers?.occlusion ??
      options.samplers?.emissive ??
      createMaterialSamplerReference('aether.sampler.linear-repeat');
    draft.set(StandardLitMaterialSchema.fields.sampler, primarySampler);
    draft.set(StandardLitMaterialSchema.fields.baseColorUvSet, options.uvSets?.baseColor ?? 0);
    draft.set(
      StandardLitMaterialSchema.fields.metallicRoughnessUvSet,
      options.uvSets?.metallicRoughness ?? 0
    );
    draft.set(StandardLitMaterialSchema.fields.normalUvSet, options.uvSets?.normal ?? 0);
    draft.set(StandardLitMaterialSchema.fields.occlusionUvSet, options.uvSets?.occlusion ?? 0);
    draft.set(StandardLitMaterialSchema.fields.emissiveUvSet, options.uvSets?.emissive ?? 0);
    if (options.transforms?.baseColor) {
      draft.set(
        StandardLitMaterialSchema.fields.baseColorTransform,
        options.transforms.baseColor.matrix
      );
      draft.set(
        StandardLitMaterialSchema.fields.baseColorOffset,
        options.transforms.baseColor.offset
      );
    }
    if (options.transforms?.metallicRoughness) {
      draft.set(
        StandardLitMaterialSchema.fields.metallicRoughnessTransform,
        options.transforms.metallicRoughness.matrix
      );
      draft.set(
        StandardLitMaterialSchema.fields.metallicRoughnessOffset,
        options.transforms.metallicRoughness.offset
      );
    }
    if (options.transforms?.normal) {
      draft.set(StandardLitMaterialSchema.fields.normalTransform, options.transforms.normal.matrix);
      draft.set(StandardLitMaterialSchema.fields.normalOffset, options.transforms.normal.offset);
    }
    if (options.transforms?.occlusion) {
      draft.set(
        StandardLitMaterialSchema.fields.occlusionTransform,
        options.transforms.occlusion.matrix
      );
      draft.set(
        StandardLitMaterialSchema.fields.occlusionOffset,
        options.transforms.occlusion.offset
      );
    }
    if (options.transforms?.emissive) {
      draft.set(
        StandardLitMaterialSchema.fields.emissiveTransform,
        options.transforms.emissive.matrix
      );
      draft.set(
        StandardLitMaterialSchema.fields.emissiveOffset,
        options.transforms.emissive.offset
      );
    }
  });
  return Object.freeze({
    asset,
    resolved,
    instance,
    ...(options.samplers ? { samplers: options.samplers } : {})
  }) as StandardLitMaterial;
}
