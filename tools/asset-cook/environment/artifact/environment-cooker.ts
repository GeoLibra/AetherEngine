/**
 * @file High-level offline environment IBL asset cooker.
 * Transforms a CanonicalHdrPanorama into EnvironmentArtifactV1 and BrdfLutArtifactV1
 * along with tightly packed RGBA16F binary blobs.
 */

import { convolveDiffuseIrradiance } from '../convolution/irradiance-integrator';
import { convolveGgxRadianceChain } from '../convolution/ggx-radiance-integrator';
import { computeBrdfLut } from '../convolution/brdf-lut-integrator';
import { packRgbToRgba16Float, packRgbaToRgba16Float } from './binary-packing';
import {
  computeBrdfLutRecipeKey,
  computeEnvironmentRecipeKey,
  computeSha256Digest
} from './recipe-key';
import type {
  BrdfLutArtifactV1,
  EnvironmentArtifactV1,
  EnvironmentCookRecipe,
  EnvironmentMip,
  EnvironmentTexturePayload
} from './types';
import type { CanonicalHdrPanorama } from '../decode/types';

export interface CookEnvironmentResult {
  readonly environmentArtifact: EnvironmentArtifactV1;
  readonly irradianceBlob: Uint8Array;
  readonly radianceBlob: Uint8Array;
  readonly brdfLutArtifact: BrdfLutArtifactV1;
  readonly brdfLutBlob: Uint8Array;
}

export const DEFAULT_COOK_RECIPES: Record<
  'smoke-v1' | 'demo-v1' | 'quality-v1',
  EnvironmentCookRecipe
> = Object.freeze({
  'smoke-v1': Object.freeze({
    recipeName: 'smoke-v1',
    irradianceSize: [16, 8] as [number, number],
    irradianceSamples: 64,
    radianceBaseSize: [64, 32] as [number, number],
    radianceSamples: 64,
    lutSize: 32,
    lutSamples: 128
  }),
  'demo-v1': Object.freeze({
    recipeName: 'demo-v1',
    irradianceSize: [32, 16] as [number, number],
    irradianceSamples: 1024,
    radianceBaseSize: [256, 128] as [number, number],
    radianceSamples: 1024,
    lutSize: 128,
    lutSamples: 2048
  }),
  'quality-v1': Object.freeze({
    recipeName: 'quality-v1',
    irradianceSize: [64, 32] as [number, number],
    irradianceSamples: 4096,
    radianceBaseSize: [512, 256] as [number, number],
    radianceSamples: 4096,
    lutSize: 256,
    lutSamples: 4096
  })
});

export function cookBrdfLut(
  size = 128,
  sampleCount = 2048
): { artifact: BrdfLutArtifactV1; blob: Uint8Array } {
  const lutPixels = computeBrdfLut({ size, sampleCount });
  const blob = packRgbaToRgba16Float(lutPixels, size, size);
  const blobHash = computeSha256Digest(blob);

  const recipeHash = computeBrdfLutRecipeKey({
    schema: 'BrdfLutArtifact@1',
    samplingAbi: 'ibl-equirect-ggx@1',
    integratorVersion: 'aether-smith-ggx@1',
    size,
    sampleCount
  });

  const levelRecord: EnvironmentMip = {
    level: 0,
    width: size,
    height: size,
    byteOffset: 0,
    byteLength: blob.byteLength,
    contentHash: blobHash
  };

  const artifact: BrdfLutArtifactV1 = {
    schema: 'BrdfLutArtifact@1',
    samplingAbi: 'ibl-equirect-ggx@1',
    recipeHash,
    integratorVersion: 'aether-smith-ggx@1',
    axes: 'nv-perceptual-roughness',
    channels: 'fresnel-scale-bias',
    payload: {
      format: 'rgba16float',
      blobHash,
      byteLength: blob.byteLength,
      levels: [levelRecord]
    }
  };

  return { artifact, blob };
}

export function cookEnvironmentPanorama(
  source: CanonicalHdrPanorama,
  recipe: EnvironmentCookRecipe = DEFAULT_COOK_RECIPES['demo-v1'],
  sharedLut?: { artifact: BrdfLutArtifactV1; blob: Uint8Array }
): CookEnvironmentResult {
  const lut = sharedLut ?? cookBrdfLut(recipe.lutSize, recipe.lutSamples);

  // 1. Irradiance map
  const [irrW, irrH] = recipe.irradianceSize;
  const irrPixels = convolveDiffuseIrradiance(source.pixels, source.width, source.height, {
    outWidth: irrW,
    outHeight: irrH,
    sampleCount: recipe.irradianceSamples
  });
  const irradianceBlob = packRgbToRgba16Float(irrPixels, irrW, irrH);
  const irrBlobHash = computeSha256Digest(irradianceBlob);

  const irradiancePayload: EnvironmentTexturePayload = {
    format: 'rgba16float',
    blobHash: irrBlobHash,
    byteLength: irradianceBlob.byteLength,
    levels: [
      {
        level: 0,
        width: irrW,
        height: irrH,
        byteOffset: 0,
        byteLength: irradianceBlob.byteLength,
        contentHash: irrBlobHash
      }
    ]
  };

  // 2. Radiance mip chain
  const [radW, radH] = recipe.radianceBaseSize;
  const radLevels = convolveGgxRadianceChain(source.pixels, source.width, source.height, {
    baseWidth: radW,
    baseHeight: radH,
    sampleCount: recipe.radianceSamples
  });

  // Calculate total radiance byte length and pack all mips into a contiguous blob
  let totalRadianceBytes = 0;
  for (const lvl of radLevels) {
    totalRadianceBytes += lvl.width * lvl.height * 8;
  }

  const radianceBlob = new Uint8Array(totalRadianceBytes);
  const radianceMipRecords: EnvironmentMip[] = [];
  let currentOffset = 0;

  for (const lvl of radLevels) {
    const levelBytes = packRgbToRgba16Float(lvl.pixels, lvl.width, lvl.height);
    radianceBlob.set(levelBytes, currentOffset);
    const levelHash = computeSha256Digest(levelBytes);

    radianceMipRecords.push({
      level: lvl.level,
      width: lvl.width,
      height: lvl.height,
      byteOffset: currentOffset,
      byteLength: levelBytes.byteLength,
      contentHash: levelHash
    });

    currentOffset += levelBytes.byteLength;
  }

  const radianceBlobHash = computeSha256Digest(radianceBlob);
  const radiancePayload: EnvironmentTexturePayload = {
    format: 'rgba16float',
    blobHash: radianceBlobHash,
    byteLength: radianceBlob.byteLength,
    levels: radianceMipRecords
  };

  // Source hash
  const sourceHash = computeSha256Digest(new Uint8Array(source.pixels.buffer));

  // Recipe key
  const recipeHash = computeEnvironmentRecipeKey({
    schema: 'EnvironmentArtifact@1',
    samplingAbi: 'ibl-equirect-ggx@1',
    sourceHash,
    toolchainVersion: 'aether-cook@1',
    recipe,
    dependencyLutHash: lut.artifact.payload.blobHash
  });

  const environmentArtifact: EnvironmentArtifactV1 = {
    schema: 'EnvironmentArtifact@1',
    samplingAbi: 'ibl-equirect-ggx@1',
    recipeHash,
    sourceHash,
    targetProfileHash: computeSha256Digest('standard-pbr-profile-v1'),
    projection: 'equirectangular',
    orientation: 'y-up-atan2-z-x-top-left@1',
    colorSpace: 'linear-srgb',
    radianceUnits: 'relative',
    diffuseNormalization: 'irradiance',
    roughnessMapping: 'linear-perceptual-valid-lod@1',
    maxValidRadianceLod: radLevels.length - 1,
    irradiance: irradiancePayload,
    radiance: radiancePayload,
    brdfLut: {
      schema: 'BrdfLutArtifact@1',
      contentHash: lut.artifact.payload.blobHash
    }
  };

  return {
    environmentArtifact,
    irradianceBlob,
    radianceBlob,
    brdfLutArtifact: lut.artifact,
    brdfLutBlob: lut.blob
  };
}
