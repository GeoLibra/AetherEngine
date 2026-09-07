/**
 * @file Deterministic SHA-256 recipe key and payload content hash computation.
 */

import { createHash } from 'node:crypto';
import { canonicalStringify } from '../../../../src/core/utils/hash';
import type { EnvironmentCookRecipe } from './types';

export function computeSha256Digest(data: string | Uint8Array): string {
  const hasher = createHash('sha256');
  if (typeof data === 'string') {
    hasher.update(data, 'utf8');
  } else {
    hasher.update(data);
  }
  return hasher.digest('hex');
}

export interface EnvironmentRecipeRecord {
  readonly schema: 'EnvironmentArtifact@1';
  readonly samplingAbi: 'ibl-equirect-ggx@1';
  readonly sourceHash: string;
  readonly toolchainVersion: string;
  readonly recipe: EnvironmentCookRecipe;
  readonly dependencyLutHash: string;
}

/**
 * Computes a domain-separated, deterministic SHA-256 recipe key.
 */
export function computeEnvironmentRecipeKey(record: EnvironmentRecipeRecord): string {
  const canonicalJson = canonicalStringify(record);
  return computeSha256Digest(`aether:environment-recipe:v1:${canonicalJson}`);
}

export interface BrdfLutRecipeRecord {
  readonly schema: 'BrdfLutArtifact@1';
  readonly samplingAbi: 'ibl-equirect-ggx@1';
  readonly integratorVersion: string;
  readonly size: number;
  readonly sampleCount: number;
}

/**
 * Computes a deterministic SHA-256 recipe key for the shared BRDF LUT.
 */
export function computeBrdfLutRecipeKey(record: BrdfLutRecipeRecord): string {
  const canonicalJson = canonicalStringify(record);
  return computeSha256Digest(`aether:brdf-lut-recipe:v1:${canonicalJson}`);
}
