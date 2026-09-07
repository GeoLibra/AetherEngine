/**
 * @file Type definitions for EnvironmentArtifact@1 and BrdfLutArtifact@1.
 * Matches specifications in engine/design/v2/05-assets-scene/07-environment-ibl-cook.md.
 */

export type ContentHash = string;

export interface EnvironmentMip {
  readonly level: number;
  readonly width: number;
  readonly height: number;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly contentHash: ContentHash;
}

export interface EnvironmentTexturePayload {
  readonly format: 'rgba16float';
  readonly blobHash: ContentHash;
  readonly byteLength: number;
  readonly levels: readonly EnvironmentMip[];
}

export interface BrdfLutArtifactV1 {
  readonly schema: 'BrdfLutArtifact@1';
  readonly samplingAbi: 'ibl-equirect-ggx@1';
  readonly recipeHash: ContentHash;
  readonly integratorVersion: string;
  readonly axes: 'nv-perceptual-roughness';
  readonly channels: 'fresnel-scale-bias';
  readonly payload: EnvironmentTexturePayload;
}

export interface EnvironmentArtifactV1 {
  readonly schema: 'EnvironmentArtifact@1';
  readonly samplingAbi: 'ibl-equirect-ggx@1';
  readonly recipeHash: ContentHash;
  readonly sourceHash: ContentHash;
  readonly targetProfileHash: ContentHash;
  readonly projection: 'equirectangular';
  readonly orientation: 'y-up-atan2-z-x-top-left@1';
  readonly colorSpace: 'linear-srgb';
  readonly radianceUnits: 'relative';
  readonly diffuseNormalization: 'irradiance';
  readonly roughnessMapping: 'linear-perceptual-valid-lod@1';
  readonly maxValidRadianceLod: number;
  readonly irradiance: EnvironmentTexturePayload;
  readonly radiance: EnvironmentTexturePayload;
  readonly brdfLut: { readonly schema: 'BrdfLutArtifact@1'; readonly contentHash: ContentHash };
}

export interface EnvironmentCookRecipe {
  readonly recipeName: 'smoke-v1' | 'demo-v1' | 'quality-v1' | 'custom';
  readonly irradianceSize: [number, number];
  readonly irradianceSamples: number;
  readonly radianceBaseSize: [number, number];
  readonly radianceSamples: number;
  readonly lutSize: number;
  readonly lutSamples: number;
}
