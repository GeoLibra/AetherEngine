/**
 * @file Source-kind authoring dispatch coordinator for shader compilation and cooking.
 * Integrates module resolution and linking for composed shaders with full diagnostic remapping.
 */

import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type {
  CookedShaderRuntimeArtifact,
  ShaderAuthoringSource,
  WgslShaderMetadata
} from '../../src/shader/types';
import { loadWgslMetadata, loadWgslMetadataSync } from './metadata-loader';
import {
  createShaderModuleId,
  FileSystemShaderModuleLoader,
  linkStrictWgsl,
  remapLinkedDiagnostic,
  resolveDependencyClosure,
  type ShaderModuleLoader,
  type ShaderModuleSource
} from './modules';
import { NativeCookerError, NativeWgslCooker } from './native-wgsl-cooker';
import {
  diagnoseShaderArtifactLayouts,
  formatStructLayoutDiagnostic,
  type StructLayoutDiagnosis
} from './struct-packing-linter';

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
  /**
   * Explicit opt-in flag to run factual struct layout diagnostics on reflected buffer layouts.
   * When true, emits neutral layout diagnostics indicating alignment gaps and padding.
   */
  readonly diagnoseLayout?: boolean | undefined;
  /**
   * Optional callback to receive layout diagnostics. When provided, diagnostics are passed
   * to this handler instead of being logged to console.info.
   */
  readonly onLayoutDiagnostic?: ((diagnostic: StructLayoutDiagnosis) => void) | undefined;
  /**
   * Custom module loader for resolving imported shader modules.
   */
  readonly moduleLoader?: ShaderModuleLoader | undefined;
  /**
   * Callback invoked for each file path loaded during dependency resolution (used for watch/HMR).
   */
  readonly onDependencyResolved?: ((filePath: string) => void) | undefined;
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

      let metadata = request.metadata;
      let effectiveMetadataPath = metadataPath;
      if (!metadata && !effectiveMetadataPath && sourcePath) {
        const sidecarMeta = `${sourcePath}.meta.json`;
        const shaderJson = sourcePath.replace(/\.wgsl$/u, '.shader.json');
        if (existsSync(sidecarMeta)) {
          effectiveMetadataPath = sidecarMeta;
        } else if (shaderJson !== sourcePath && existsSync(shaderJson)) {
          effectiveMetadataPath = shaderJson;
        }
      }
      if (!metadata && effectiveMetadataPath) {
        metadata = loadWgslMetadataSync(effectiveMetadataPath);
      }

      let artifact: CookedShaderRuntimeArtifact;

      // Check if this module declares external imports requiring resolution & linking
      if (metadata?.imports && metadata.imports.length > 0) {
        const rootSourceText = readFileSync(sourcePath, 'utf8');
        const rootModuleSource: ShaderModuleSource = Object.freeze({
          id: createShaderModuleId(source.uri),
          source: rootSourceText,
          imports: Object.freeze([...metadata.imports])
        });

        const loader =
          options.moduleLoader ??
          new FileSystemShaderModuleLoader({
            fileOverrides: {
              [source.uri]: sourcePath
            },
            moduleOverrides: {
              [source.uri]: rootModuleSource
            }
          });
        const closure = await resolveDependencyClosure(source.uri, loader);

        if (options.onDependencyResolved) {
          options.onDependencyResolved(sourcePath);
          if (effectiveMetadataPath) {
            options.onDependencyResolved(effectiveMetadataPath);
          }
          if (loader instanceof FileSystemShaderModuleLoader) {
            for (const filePath of loader.getLoadedFilePaths()) {
              options.onDependencyResolved(filePath);
            }
          }
        }

        const linked = linkStrictWgsl(closure);

        // Write linked standard WGSL to temporary file for native cooker invocation
        const tempDir = await mkdtemp(join(tmpdir(), 'aether-linked-cook-'));
        const tempSourcePath = join(tempDir, basename(sourcePath));
        await writeFile(tempSourcePath, linked.standardWgsl, 'utf8');

        try {
          artifact = await cooker.cook(
            {
              sourcePath: tempSourcePath,
              sourceUri: source.uri,
              ...(effectiveMetadataPath !== undefined
                ? { metadataPath: effectiveMetadataPath }
                : {})
            },
            { signal: options.signal }
          );
        } catch (cookError: unknown) {
          if (cookError instanceof NativeCookerError) {
            let line = cookError.line;
            let col = cookError.column;

            if (line === undefined) {
              const lineMatch =
                /line\s+(\d+)/i.exec(cookError.message) ?? /:(\d+):(\d+)/.exec(cookError.message);
              if (lineMatch && lineMatch[1]) {
                line = parseInt(lineMatch[1], 10);
                if (lineMatch[2]) {
                  col = parseInt(lineMatch[2], 10);
                }
              }
            }

            if (line !== undefined) {
              const mapped = remapLinkedDiagnostic(
                { line, column: col, message: cookError.message },
                linked
              );
              const colSuffix = mapped.span?.column !== undefined ? `:${mapped.span.column}` : '';
              const mappedLocation = `${mapped.moduleId}:${mapped.span?.line ?? 1}${colSuffix}`;
              const mappedMessage = `${cookError.code}: [${mappedLocation}] ${cookError.message}`;

              throw new NativeCookerError(mappedMessage, {
                code: cookError.code,
                sourceUri: (mapped.moduleId as string) ?? cookError.sourceUri,
                rawStderr: cookError.rawStderr,
                line: mapped.span?.line,
                column: mapped.span?.column,
                backendStage: cookError.backendStage
              });
            }
          }
          throw cookError;
        } finally {
          await rm(tempDir, { recursive: true, force: true }).catch(() => {});
        }
      } else {
        artifact = await cooker.cook(
          {
            sourcePath,
            sourceUri: source.uri,
            ...(effectiveMetadataPath !== undefined ? { metadataPath: effectiveMetadataPath } : {})
          },
          { signal: options.signal }
        );
      }

      if (metadata) {
        if (!metadata.entryPoints || metadata.entryPoints.length === 0) {
          throw new Error(
            'Executable WGSL root shader metadata must declare at least one entry point.'
          );
        }
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

      if (options.diagnoseLayout === true) {
        const structDiagnoses = diagnoseShaderArtifactLayouts(artifact);
        for (const diagnosis of structDiagnoses) {
          if (options.onLayoutDiagnostic) {
            options.onLayoutDiagnostic(diagnosis);
          } else {
            console.info(formatStructLayoutDiagnostic(diagnosis, source.uri));
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
