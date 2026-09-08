/**
 * @file Canonical manifest serializer and validator for EnvironmentArtifact@1, EnvironmentArtifact@2, and BrdfLutArtifact@1.
 * Pure TypeScript functions with zero tooling dependencies, safe for runtime inclusion.
 */

import { canonicalStringify } from '../../../core/utils/hash';
import type {
  BackgroundPayload,
  BrdfLutArtifactV1,
  EnvironmentArtifact,
  EnvironmentArtifactV1,
  EnvironmentArtifactV2
} from './types';

export function serializeEnvironmentManifest(artifact: EnvironmentArtifact): string {
  validateEnvironmentArtifact(artifact);
  return canonicalStringify(artifact);
}

export function deserializeEnvironmentManifest(jsonString: string): EnvironmentArtifact {
  const parsed = JSON.parse(jsonString) as unknown;
  validateEnvironmentArtifact(parsed);
  return parsed as EnvironmentArtifact;
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

export function validateEnvironmentArtifact(value: unknown): asserts value is EnvironmentArtifact {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Environment artifact must be an object.');
  }

  const a = value as Partial<EnvironmentArtifact>;
  if (a.schema === 'EnvironmentArtifact@1') {
    validateEnvironmentArtifactV1(value);
    return;
  }
  if (a.schema === 'EnvironmentArtifact@2') {
    validateEnvironmentArtifactV2(value);
    return;
  }

  throw new Error(
    `Invalid environment schema "${a.schema}". Expected "EnvironmentArtifact@1" or "EnvironmentArtifact@2".`
  );
}

export function validateEnvironmentArtifactV1(
  value: unknown
): asserts value is EnvironmentArtifactV1 {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Environment artifact must be an object.');
  }

  const a = value as Partial<EnvironmentArtifactV1>;
  if (a.schema !== 'EnvironmentArtifact@1') {
    throw new Error(`Invalid environment schema "${a.schema}". Expected "EnvironmentArtifact@1".`);
  }
  validateSharedEnvironmentFields(a);
}

export function validateEnvironmentArtifactV2(
  value: unknown
): asserts value is EnvironmentArtifactV2 {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Environment artifact must be an object.');
  }

  const a = value as Partial<EnvironmentArtifactV2>;
  if (a.schema !== 'EnvironmentArtifact@2') {
    throw new Error(`Invalid environment schema "${a.schema}". Expected "EnvironmentArtifact@2".`);
  }
  validateSharedEnvironmentFields(a);
  validateBackgroundPayload(a.background);
}

function validateSharedEnvironmentFields(a: Partial<Omit<EnvironmentArtifactV1, 'schema'>>): void {
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
  validateTexturePayload(a.irradiance, 'irradiance');
  validateTexturePayload(a.radiance, 'radiance');
  if (!a.brdfLut || a.brdfLut.schema !== 'BrdfLutArtifact@1' || !a.brdfLut.contentHash) {
    throw new Error('Invalid or missing brdfLut reference in environment artifact.');
  }
}

export function validateBackgroundPayload(value: unknown): asserts value is BackgroundPayload {
  if (typeof value !== 'object' || value === null) {
    throw new Error('Background payload must be an object.');
  }
  const bg = value as Partial<BackgroundPayload>;
  if (bg.kind === 'absent') {
    return;
  }
  if (bg.kind === 'panorama') {
    if (bg.samplingAbi !== 'sky-equirect-linear@1') {
      throw new Error(
        `Invalid background sampling ABI "${bg.samplingAbi}". Expected "sky-equirect-linear@1".`
      );
    }
    if (bg.mipFilter !== 'spherical-area@1') {
      throw new Error(
        `Invalid background mip filter "${bg.mipFilter}". Expected "spherical-area@1".`
      );
    }
    validateTexturePayload(bg.payload, 'background.payload');
    return;
  }
  throw new Error(
    `Invalid background payload kind "${(bg as { kind?: unknown }).kind}". Expected "absent" or "panorama".`
  );
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
    throw new Error(
      `Invalid BRDF LUT sampling ABI "${b.samplingAbi}". Expected "ibl-equirect-ggx@1".`
    );
  }
  if (!b.recipeHash || !b.integratorVersion) {
    throw new Error('BRDF LUT artifact missing recipeHash or integratorVersion.');
  }
  if (b.axes !== 'nv-perceptual-roughness' || b.channels !== 'fresnel-scale-bias') {
    throw new Error('Invalid BRDF LUT axes or channels configuration.');
  }
  validateTexturePayload(b.payload, 'payload');
}

function validateTexturePayload(value: unknown, label: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`Texture payload "${label}" must be an object.`);
  }
  const p = value as Record<string, unknown>;
  if (p.format !== 'rgba16float') {
    throw new Error(`Unsupported texture payload format "${p.format}". Expected "rgba16float".`);
  }
  if (typeof p.blobHash !== 'string' || !p.blobHash) {
    throw new Error(`Missing blobHash for texture payload "${label}".`);
  }
  if (typeof p.byteLength !== 'number' || p.byteLength <= 0) {
    throw new Error(`Invalid byteLength for texture payload "${label}".`);
  }
  if (!Array.isArray(p.levels) || p.levels.length === 0) {
    throw new Error(`Texture payload "${label}" must contain at least one mip level.`);
  }
}
