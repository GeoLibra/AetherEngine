import type { MaterialAsset, MaterialInstance, ResolvedMaterialAsset } from './asset-types';
import type { MaterialSamplerReference, MaterialTextureReference } from './schema-types';

/** Supported surface alpha blending behaviors for standard lit materials. */
export type StandardLitAlphaMode = 'opaque' | 'mask' | 'blend';

/** UV texture coordinate set mapping (UV0 or UV1) for material textures. */
export interface StandardLitUvSets {
  readonly baseColor?: 0 | 1;
  readonly metallicRoughness?: 0 | 1;
  readonly normal?: 0 | 1;
  readonly occlusion?: 0 | 1;
  readonly emissive?: 0 | 1;
}

/** Pre-composed 2D affine transform (column-major 2x2 matrix and 2D translation offset). */
export interface TextureUvAffineTransform {
  readonly matrix: readonly [number, number, number, number];
  readonly offset: readonly [number, number];
}

/** Per-texture UV coordinate affine transformations. */
export interface StandardLitTextureTransforms {
  readonly baseColor?: TextureUvAffineTransform | undefined;
  readonly metallicRoughness?: TextureUvAffineTransform | undefined;
  readonly normal?: TextureUvAffineTransform | undefined;
  readonly occlusion?: TextureUvAffineTransform | undefined;
  readonly emissive?: TextureUvAffineTransform | undefined;
}

/** Per-texture explicit sampler override references. */
export interface StandardLitSamplers {
  readonly baseColor?: MaterialSamplerReference | undefined;
  readonly metallicRoughness?: MaterialSamplerReference | undefined;
  readonly normal?: MaterialSamplerReference | undefined;
  readonly occlusion?: MaterialSamplerReference | undefined;
  readonly emissive?: MaterialSamplerReference | undefined;
}

/** Configuration options for instantiating a standard-lit material. */
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
  readonly samplers?: StandardLitSamplers;
  readonly uvSets?: StandardLitUvSets;
  readonly transforms?: StandardLitTextureTransforms;
}

/** Immutable built-in asset ownership bundle returned to renderer composition. */
export interface StandardLitMaterial {
  readonly asset: MaterialAsset;
  readonly resolved: ResolvedMaterialAsset;
  readonly instance: MaterialInstance;
  readonly samplers?: StandardLitSamplers;
}
