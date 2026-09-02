/**
 * @file Pure runtime loader and resolver for cooked shader artifacts.
 */

import { decodeCookedShaderRuntimeArtifact } from '../artifact';
import type {
  CookedShaderBinding,
  CookedShaderRuntimeArtifact,
  ShaderStage,
  ShaderTarget
} from '../types';

/**
 * Selection criteria for extracting an executable backend shader module from a cooked artifact.
 */
export interface CookedShaderModuleSelection {
  readonly target: ShaderTarget;
  readonly entry: string;
  readonly stage?: ShaderStage | undefined;
}

/**
 * Validated backend module extracted from a cooked artifact ready for RHI consumption.
 */
export interface LoadedCookedShaderModule {
  readonly target: ShaderTarget;
  readonly entry: string;
  readonly stage: ShaderStage;
  readonly source: string;
  readonly bindings: readonly CookedShaderBinding[];
  readonly sourceUri: string;
  readonly contentHash: string;
}

/**
 * Pure function to extract a target backend shader module from a validated cooked artifact.
 *
 * @param artifact Cooked runtime artifact snapshot.
 * @param selection Backend target and entry point selection.
 * @returns Immutable LoadedCookedShaderModule snapshot.
 * @throws {Error} When entry point is missing ([artifact-entry-missing]), target is unsupported ([artifact-target-unsupported]), or module is missing ([artifact-module-missing]).
 */
export function loadCookedShaderModule(
  artifact: CookedShaderRuntimeArtifact,
  selection: CookedShaderModuleSelection
): LoadedCookedShaderModule {
  if (!selection || typeof selection !== 'object') {
    throw new Error('Selection must be a non-null object.');
  }

  // Validate and defensively copy untrusted artifact input at trust boundary
  const validatedArtifact = decodeCookedShaderRuntimeArtifact(artifact);

  const entryPoint = validatedArtifact.entryPoints.find((ep) => ep.name === selection.entry);
  if (!entryPoint) {
    throw new Error(
      `[artifact-entry-missing] Entry point "${selection.entry}" was not found in cooked shader artifact for "${validatedArtifact.source.sourceUri}".`
    );
  }

  if (selection.stage !== undefined && selection.stage !== entryPoint.stage) {
    throw new Error(
      `[artifact-stage-mismatch] Requested stage "${selection.stage}" does not match entry point "${entryPoint.name}" stage "${entryPoint.stage}".`
    );
  }

  switch (selection.target) {
    case 'wgsl': {
      return Object.freeze({
        target: 'wgsl' as const,
        entry: entryPoint.name,
        stage: entryPoint.stage,
        source: validatedArtifact.modules.wgsl,
        bindings: entryPoint.bindings,
        sourceUri: validatedArtifact.source.sourceUri,
        contentHash: validatedArtifact.source.contentHash
      });
    }

    case 'glsl300es': {
      if (entryPoint.stage === 'compute') {
        throw new Error(
          `[artifact-target-unsupported] Compute stage entry point "${entryPoint.name}" has no GLSL ES 300 backend module.`
        );
      }

      const glslKey = `${entryPoint.stage}:${entryPoint.name}`;
      const glslSource = validatedArtifact.modules.glslEs300[glslKey];
      if (!glslSource) {
        throw new Error(
          `[artifact-module-missing] GLSL ES 300 module for "${glslKey}" was not found in cooked shader artifact.`
        );
      }

      return Object.freeze({
        target: 'glsl300es' as const,
        entry: entryPoint.name,
        stage: entryPoint.stage,
        source: glslSource.source,
        bindings: entryPoint.bindings,
        sourceUri: validatedArtifact.source.sourceUri,
        contentHash: validatedArtifact.source.contentHash
      });
    }

    default: {
      const unknownTarget = (selection as CookedShaderModuleSelection).target;
      throw new Error(
        `[artifact-target-unsupported] Unsupported target backend "${String(unknownTarget)}".`
      );
    }
  }
}
