/**
 * @file Source-kind authoring dispatch coordinator for shader compilation and cooking.
 */

import type {
  CookedShaderRuntimeArtifact,
  ShaderAuthoringSource,
  WgslShaderMetadata
} from '../../src/shader/types';
import { NativeWgslCooker } from './native-wgsl-cooker';
import { loadWgslMetadata } from './metadata-loader';

/**
 * Request payload for cooking an authored shader.
 */
export interface CookAuthoredShaderRequest {
  readonly source: ShaderAuthoringSource;
  readonly sourcePath: string;
  readonly metadataPath?: string | undefined;
  readonly metadata?: WgslShaderMetadata | undefined;
}

/**
 * Adapter interface for experimental FluxSL compilation during migration.
 */
export interface FluxShaderCookerAdapter {
  readonly cook: (request: CookAuthoredShaderRequest) => Promise<CookedShaderRuntimeArtifact>;
}

/**
 * Options for cookAuthoredShader dispatch.
 */
export interface CookAuthoredShaderOptions {
  readonly allowExperimentalFlux?: boolean | undefined;
  readonly cooker?: NativeWgslCooker | undefined;
  readonly fluxCooker?: FluxShaderCookerAdapter | undefined;
  readonly signal?: AbortSignal | undefined;
}

/**
 * Dispatches an authored shader source to the appropriate compiler/cooker according to its source kind.
 *
 * @param request Source definition, file paths, and optional metadata.
 * @param options Cooker options, cancellation signal, and experimental opt-ins.
 * @returns Validated CookedShaderRuntimeArtifact.
 * @throws {Error} When flux-experimental is used without explicit opt-in, when shader-graph is invoked, or when reflection mismatches metadata.
 */
export async function cookAuthoredShader(
  request: CookAuthoredShaderRequest,
  options: CookAuthoredShaderOptions = {}
): Promise<CookedShaderRuntimeArtifact> {
  const { source, sourcePath, metadataPath } = request;

  switch (source.kind) {
    case 'wgsl': {
      const cooker = options.cooker ?? new NativeWgslCooker();
      const artifact = await cooker.cook(
        {
          sourcePath,
          sourceUri: source.uri,
          metadataPath
        },
        { signal: options.signal }
      );

      let metadata = request.metadata;
      if (!metadata && metadataPath) {
        metadata = await loadWgslMetadata(metadataPath);
      }

      if (metadata) {
        // Cross-check metadata declarations with native reflection
        const reflectedEntries = new Map(artifact.entryPoints.map((ep) => [ep.name, ep.stage]));
        for (const metaEp of metadata.entryPoints) {
          const reflectedStage = reflectedEntries.get(metaEp.name);
          if (!reflectedStage) {
            throw new Error(
              `Metadata entry point "${metaEp.name}" is not present in native reflection.`
            );
          }
          if (reflectedStage !== metaEp.stage) {
            throw new Error(
              `Metadata entry point "${metaEp.name}" declares stage "${metaEp.stage}", but native reflection found "${reflectedStage}".`
            );
          }
        }
      }

      return artifact;
    }

    case 'flux-experimental': {
      if (options.allowExperimentalFlux !== true) {
        throw new Error(
          'flux-experimental requires explicit opt-in via allowExperimentalFlux: true.'
        );
      }
      if (!options.fluxCooker) {
        throw new Error('No FluxSL cooker adapter was provided for flux-experimental cooking.');
      }
      return options.fluxCooker.cook(request);
    }

    case 'shader-graph': {
      throw new Error('shader-graph authoring is not yet supported for cooking.');
    }

    default: {
      const unknownKind = (source as ShaderAuthoringSource).kind;
      throw new Error(`Unsupported shader source kind "${String(unknownKind)}".`);
    }
  }
}
