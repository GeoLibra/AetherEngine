/**
 * @file Canonical manifest serializer and validator for EnvironmentArtifact@1 and BrdfLutArtifact@1.
 */

import { canonicalStringify } from '../../../../src/core/utils/hash';
import type { BrdfLutArtifactV1, EnvironmentArtifactV1 } from './types';

export function serializeEnvironmentManifest(artifact: EnvironmentArtifactV1): string {
  validateEnvironmentArtifact(artifact);
  return canonicalStringify(artifact);
}

export function deserializeEnvironmentManifest(jsonString: string): EnvironmentArtifactV1 {
  const parsed = JSON.parse(jsonString) as unknown;
  validateEnvironmentArtifact(parsed);
  return parsed as EnvironmentArtifactV1;
}

export function serializeBrdfLutManifest(artifact: BrdfLutArtifactV1): string {
  validateBrdfLutArtifact(artifact);
  return canonicalStringify(artifact);
}

export function deserializeBrdfLutManifest(jsonString: string): BrdfLutArtifactV1 {
  const parsed = JSON.parse(jsonString) as unknown;
  validateBrdfLutArtifact(parsed);
  return parsed as BrdfLutArtifactV1;
}

export function validateEnvironmentArtifact(
  value: unknown
): asserts value is EnvironmentArtifactV1 {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Environment artifact must be an object.');
  }

  const a = value as Partial<EnvironmentArtifactV1>;
  if (a.schema !== 'EnvironmentArtifact@1') {
    throw new Error(`Invalid environment schema "${a.schema}". Expected "EnvironmentArtifact@1".`);
  }
  if (a.samplingAbi !== 'ibl-equirect-ggx@1') {
    throw new Error(`Invalid sampling ABI "${a.samplingAbi}". Expected "ibl-equirect-ggx@1".`);
  }
  if (!a.recipeHash || !a.sourceHash || !a.targetProfileHash) {
    throw new Error('Environment artifact missing required hash identifiers.');
  }
  if (a.projection !== 'equirectangular') {
    throw new Error(`Unsupported projection "${a.projection}".`);
  }
  if (a.orientation !== 'y-up-atan2-z-x-top-left@1') {
    throw new Error(`Unsupported orientation "${a.orientation}".`);
  }
  if (typeof a.maxValidRadianceLod !== 'number' || a.maxValidRadianceLod < 1) {
    throw new Error(`Invalid maxValidRadianceLod: ${a.maxValidRadianceLod}.`);
  }
  if (
    !a.irradiance ||
    a.irradiance.format !== 'rgba16float' ||
    !Array.isArray(a.irradiance.levels)
  ) {
    throw new Error('Invalid irradiance payload in environment artifact.');
  }
  if (!a.radiance || a.radiance.format !== 'rgba16float' || !Array.isArray(a.radiance.levels)) {
    throw new Error('Invalid radiance payload in environment artifact.');
  }
  if (!a.brdfLut || a.brdfLut.schema !== 'BrdfLutArtifact@1' || !a.brdfLut.contentHash) {
    throw new Error('Invalid BRDF LUT reference in environment artifact.');
  }
}

export function validateBrdfLutArtifact(value: unknown): asserts value is BrdfLutArtifactV1 {
  if (typeof value !== 'object' || value === null) {
    throw new Error('BRDF LUT artifact must be an object.');
  }

  const b = value as Partial<BrdfLutArtifactV1>;
  if (b.schema !== 'BrdfLutArtifact@1') {
    throw new Error(`Invalid BRDF LUT schema "${b.schema}". Expected "BrdfLutArtifact@1".`);
  }
  if (b.samplingAbi !== 'ibl-equirect-ggx@1') {
    throw new Error(`Invalid sampling ABI "${b.samplingAbi}". Expected "ibl-equirect-ggx@1".`);
  }
  if (b.axes !== 'nv-perceptual-roughness') {
    throw new Error(`Unsupported axes "${b.axes}". Expected "nv-perceptual-roughness".`);
  }
  if (b.channels !== 'fresnel-scale-bias') {
    throw new Error(`Unsupported channels "${b.channels}". Expected "fresnel-scale-bias".`);
  }
  if (!b.payload || b.payload.format !== 'rgba16float' || !Array.isArray(b.payload.levels)) {
    throw new Error('Invalid payload in BRDF LUT artifact.');
  }
}
