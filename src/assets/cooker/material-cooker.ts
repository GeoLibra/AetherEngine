import {
  createStandardLitMaterial,
  type StandardLitMaterial,
  type StandardLitMaterialOptions,
  type StandardLitSamplers
} from '../../material/builtins';
import { composeTextureUvTransform } from '../canonical';
import type { CanonicalSamplerDocument, CanonicalStandardPbrMaterial } from '../canonical/types';
import { BUILTIN_SAMPLER_IDS, BUILTIN_TEXTURE_IDS, getCookedTextureId } from './texture-cooker';

export interface UnsupportedGltfMaterialErrorOptions {
  readonly code?: string;
  readonly materialId: string;
  readonly message: string;
  readonly conflicts?: readonly { readonly slot: string; readonly samplerId: string }[] | undefined;
}

export class UnsupportedGltfMaterialError extends Error {
  readonly code: string;
  readonly materialId: string;
  readonly conflicts?: readonly { readonly slot: string; readonly samplerId: string }[] | undefined;

  constructor(options: UnsupportedGltfMaterialErrorOptions) {
    super(options.message);
    this.name = 'UnsupportedGltfMaterialError';
    this.code = options.code ?? 'unsupported-heterogeneous-samplers';
    this.materialId = options.materialId;
    if (options.conflicts !== undefined) {
      this.conflicts = options.conflicts;
    }
  }
}

export interface MaterialCookOptions {
  readonly samplers?:
    ReadonlyMap<string, CanonicalSamplerDocument> | readonly CanonicalSamplerDocument[];
}

export interface StandardPbrFeatureKey {
  readonly baseColorTexture: boolean;
  readonly metallicRoughnessTexture: boolean;
  readonly normalTexture: boolean;
  readonly occlusionTexture: boolean;
  readonly emissiveTexture: boolean;
  readonly vertexColor: boolean;
  readonly alphaMode: 'opaque' | 'mask' | 'blend';
  readonly doubleSided: boolean;
  readonly uvMask: number;
}

/**
 * Computes the normalized pipeline feature key from a canonical PBR material.
 */
export function computeStandardPbrFeatureKey(
  material: CanonicalStandardPbrMaterial,
  hasVertexColor = false
): StandardPbrFeatureKey {
  let uvMask = 0;
  if (material.baseColorTexture?.texCoord === 1) uvMask |= 1 << 0;
  if (material.metallicRoughnessTexture?.texCoord === 1) uvMask |= 1 << 1;
  if (material.normalTexture?.texCoord === 1) uvMask |= 1 << 2;
  if (material.occlusionTexture?.texCoord === 1) uvMask |= 1 << 3;
  if (material.emissiveTexture?.texCoord === 1) uvMask |= 1 << 4;

  return {
    baseColorTexture: material.baseColorTexture !== null,
    metallicRoughnessTexture: material.metallicRoughnessTexture !== null,
    normalTexture: material.normalTexture !== null,
    occlusionTexture: material.occlusionTexture !== null,
    emissiveTexture: material.emissiveTexture !== null,
    vertexColor: hasVertexColor,
    alphaMode: material.alphaMode,
    doubleSided: material.doubleSided,
    uvMask
  };
}

/**
 * Converts a CanonicalStandardPbrMaterial into runtime StandardLitMaterialOptions.
 */
export function canonicalMaterialToStandardLitOptions(
  material: CanonicalStandardPbrMaterial,
  _options?: MaterialCookOptions
): StandardLitMaterialOptions {
  // Collect per-slot samplers for full V2 Slice 2 sampler mapping
  const samplers: StandardLitSamplers = {
    ...(material.baseColorTexture
      ? { baseColor: { kind: 'sampler', assetId: material.baseColorTexture.samplerId } }
      : {}),
    ...(material.metallicRoughnessTexture
      ? {
          metallicRoughness: {
            kind: 'sampler',
            assetId: material.metallicRoughnessTexture.samplerId
          }
        }
      : {}),
    ...(material.normalTexture
      ? { normal: { kind: 'sampler', assetId: material.normalTexture.samplerId } }
      : {}),
    ...(material.occlusionTexture
      ? { occlusion: { kind: 'sampler', assetId: material.occlusionTexture.samplerId } }
      : {}),
    ...(material.emissiveTexture
      ? { emissive: { kind: 'sampler', assetId: material.emissiveTexture.samplerId } }
      : {})
  };

  const primarySamplerId =
    material.baseColorTexture?.samplerId ??
    material.normalTexture?.samplerId ??
    material.metallicRoughnessTexture?.samplerId ??
    material.occlusionTexture?.samplerId ??
    material.emissiveTexture?.samplerId ??
    BUILTIN_SAMPLER_IDS.LinearRepeat;

  return {
    baseColor: material.baseColorFactor,
    metallic: material.metallicFactor,
    roughness: material.roughnessFactor,
    emissiveFactor: material.emissiveFactor,
    normalScale: material.normalTexture?.scale ?? 1,
    occlusionStrength: material.occlusionTexture?.strength ?? 1,
    alphaMode: material.alphaMode,
    alphaCutoff: material.alphaCutoff,
    doubleSided: material.doubleSided,
    baseColorTexture: {
      kind: 'texture',
      assetId: material.baseColorTexture
        ? getCookedTextureId(material.baseColorTexture.textureId, 'base-color')
        : BUILTIN_TEXTURE_IDS.WhiteSrgb
    },
    metallicRoughnessTexture: {
      kind: 'texture',
      assetId: material.metallicRoughnessTexture
        ? getCookedTextureId(material.metallicRoughnessTexture.textureId, 'metallic-roughness')
        : BUILTIN_TEXTURE_IDS.WhiteData
    },
    normalTexture: {
      kind: 'texture',
      assetId: material.normalTexture
        ? getCookedTextureId(material.normalTexture.textureId, 'normal')
        : BUILTIN_TEXTURE_IDS.FlatNormal
    },
    occlusionTexture: {
      kind: 'texture',
      assetId: material.occlusionTexture
        ? getCookedTextureId(material.occlusionTexture.textureId, 'occlusion')
        : BUILTIN_TEXTURE_IDS.WhiteData
    },
    emissiveTexture: {
      kind: 'texture',
      assetId: material.emissiveTexture
        ? getCookedTextureId(material.emissiveTexture.textureId, 'emissive')
        : BUILTIN_TEXTURE_IDS.BlackSrgb
    },
    sampler: {
      kind: 'sampler',
      assetId: primarySamplerId
    },
    samplers: Object.freeze(samplers),
    uvSets: {
      baseColor: material.baseColorTexture?.texCoord ?? 0,
      metallicRoughness: material.metallicRoughnessTexture?.texCoord ?? 0,
      normal: material.normalTexture?.texCoord ?? 0,
      occlusion: material.occlusionTexture?.texCoord ?? 0,
      emissive: material.emissiveTexture?.texCoord ?? 0
    },
    transforms: {
      baseColor: material.baseColorTexture?.transform
        ? composeTextureUvTransform(material.baseColorTexture.transform)
        : undefined,
      metallicRoughness: material.metallicRoughnessTexture?.transform
        ? composeTextureUvTransform(material.metallicRoughnessTexture.transform)
        : undefined,
      normal: material.normalTexture?.transform
        ? composeTextureUvTransform(material.normalTexture.transform)
        : undefined,
      occlusion: material.occlusionTexture?.transform
        ? composeTextureUvTransform(material.occlusionTexture.transform)
        : undefined,
      emissive: material.emissiveTexture?.transform
        ? composeTextureUvTransform(material.emissiveTexture.transform)
        : undefined
    }
  };
}

/**
 * Cooks a CanonicalStandardPbrMaterial into a live StandardLitMaterial bundle.
 */
export function cookCanonicalMaterial(
  material: CanonicalStandardPbrMaterial,
  options?: MaterialCookOptions
): StandardLitMaterial {
  const litOptions = canonicalMaterialToStandardLitOptions(material, options);
  return createStandardLitMaterial(litOptions);
}
