import type {
  WebGL2BindingKind,
  WebGL2BindingManifestEntry,
  WebGL2PhysicalBinding,
  WebGL2ProgramBinding,
  WebGL2ShaderTranslationPort
} from '../types';
import { decodeCookedShaderRuntimeArtifact } from '../../../shader/artifact';
import type { CookedGlslEs300Module, CookedShaderRuntimeArtifact } from '../../../shader/types';

export type WebGL2TranslationInput = Parameters<WebGL2ShaderTranslationPort['translate']>[0];

/** Configuration options for the generic cooked artifact WebGL2 translator adapter. */
export interface CookedArtifactWebGL2TranslatorOptions {
  readonly artifact: CookedShaderRuntimeArtifact;
  readonly translatorId?: string;
  readonly version?: number;
  /** Optional restriction on allowed entry point names. Defaults to all entry points in artifact. */
  readonly supportedEntryPoints?: readonly string[];
  /** Optional target ABI fingerprint or generator function. */
  readonly targetAbiFingerprint?: string | ((input: WebGL2TranslationInput) => string);
  /** Optional custom physical binding mapping override (e.g. sampler fanout). */
  readonly mapPhysicalBindings?: (
    activeBindings: readonly WebGL2BindingManifestEntry[],
    emittedModule: CookedGlslEs300Module,
    input: WebGL2TranslationInput
  ) => readonly WebGL2PhysicalBinding[];
  /** Optional custom program binding mapping override. */
  readonly mapProgramBindings?: (
    emittedModule: CookedGlslEs300Module,
    input: WebGL2TranslationInput
  ) => readonly WebGL2ProgramBinding[];
  /** Optional required GLSL extensions or generator function. */
  readonly requiredExtensions?:
    readonly string[] | ((input: WebGL2TranslationInput) => readonly string[]);
}

const EMPTY_LIST: readonly string[] = Object.freeze([]);
const EMPTY_SOURCE_MAP: readonly Readonly<{ generatedLine: number; authoredLine: number }>[] =
  Object.freeze([]);

function isCookedArtifactOptions(
  input: CookedShaderRuntimeArtifact | CookedArtifactWebGL2TranslatorOptions
): input is CookedArtifactWebGL2TranslatorOptions {
  return typeof input === 'object' && input !== null && 'artifact' in input;
}

function deriveShaderStem(sourceUri: string): string {
  const match = /\/([^/]+)\.wgsl$/.exec(sourceUri);
  return match ? match[1]! : 'shader';
}

/**
 * Creates a standard WebGL2 translation port adapter from a validated cooked runtime artifact.
 * Encapsulates binding translation, GLSL header stripping, physical/program slot assignment,
 * and deterministic ABI fingerprints.
 *
 * Can accept either a CookedShaderRuntimeArtifact directly (inferring ID, version, and entry points)
 * or explicit CookedArtifactWebGL2TranslatorOptions.
 *
 * @throws When requested entry points or bindings are missing or unsupported.
 */
export function createCookedArtifactWebGL2Translator(
  artifactOrOptions: CookedShaderRuntimeArtifact | CookedArtifactWebGL2TranslatorOptions
): WebGL2ShaderTranslationPort {
  const isOptions = isCookedArtifactOptions(artifactOrOptions);
  const artifact = isOptions ? artifactOrOptions.artifact : artifactOrOptions;
  const options = isOptions ? artifactOrOptions : undefined;

  const validated = decodeCookedShaderRuntimeArtifact(artifact);
  const stem = deriveShaderStem(validated.source.sourceUri);
  const translatorId = options?.translatorId ?? `aether.${stem}.naga-glsl`;
  const version = options?.version ?? validated.schemaVersion;
  const supportedEntryPoints = options?.supportedEntryPoints
    ? new Set(options.supportedEntryPoints)
    : undefined;

  return Object.freeze({
    translatorId,
    version,
    translate(input: WebGL2TranslationInput) {
      if (supportedEntryPoints && !supportedEntryPoints.has(input.entryPoint)) {
        throw new Error(
          `Unsupported entry point "${input.entryPoint}" for translator "${translatorId}".`
        );
      }

      const key = `${input.stage}:${input.entryPoint}`;
      const emitted = validated.modules.glslEs300[key];
      const entryPoint = validated.entryPoints.find(
        (entry) => entry.stage === input.stage && entry.name === input.entryPoint
      );

      if (!emitted || !entryPoint) {
        throw new Error(
          `Missing cooked module for "${input.entryPoint}" (stage: "${input.stage}") in translator "${translatorId}".`
        );
      }

      const activeBindings: readonly WebGL2BindingManifestEntry[] = Object.freeze(
        entryPoint.bindings.map((binding) => {
          if (
            binding.kind !== 'uniform-buffer' &&
            binding.kind !== 'texture' &&
            binding.kind !== 'sampler'
          ) {
            throw new Error(
              `Unsupported WebGL2 binding kind "${binding.kind}" in entry point "${input.entryPoint}".`
            );
          }
          return Object.freeze({
            group: binding.group,
            binding: binding.binding,
            name: binding.name,
            kind: binding.kind as WebGL2BindingKind
          });
        })
      );

      const physicalBindings: readonly WebGL2PhysicalBinding[] = options?.mapPhysicalBindings
        ? Object.freeze(options.mapPhysicalBindings(activeBindings, emitted, input))
        : Object.freeze(
            activeBindings.flatMap((binding) => {
              if (binding.kind !== 'sampler') {
                return [
                  Object.freeze({
                    group: binding.group,
                    binding: binding.binding,
                    kind: binding.kind,
                    slot: binding.kind === 'uniform-buffer' ? binding.group : binding.binding
                  })
                ];
              }
              const matchingCombined = emitted.bindings.flatMap((programBinding) =>
                programBinding.kind === 'combined-sampler' &&
                programBinding.sampler?.group === binding.group &&
                programBinding.sampler.binding === binding.binding
                  ? [programBinding]
                  : []
              );
              if (matchingCombined.length > 0) {
                return matchingCombined.map((programBinding) =>
                  Object.freeze({
                    group: binding.group,
                    binding: binding.binding,
                    kind: binding.kind,
                    slot: programBinding.texture.binding
                  })
                );
              }
              return [
                Object.freeze({
                  group: binding.group,
                  binding: binding.binding,
                  kind: binding.kind,
                  slot: binding.binding
                })
              ];
            })
          );

      const programBindings: readonly WebGL2ProgramBinding[] = options?.mapProgramBindings
        ? Object.freeze(options.mapProgramBindings(emitted, input))
        : Object.freeze(
            emitted.bindings.map((binding) =>
              binding.kind === 'uniform-buffer'
                ? Object.freeze({
                    kind: 'uniform-buffer' as const,
                    name: binding.name,
                    slot: binding.resource.group
                  })
                : Object.freeze({
                    kind: 'combined-sampler' as const,
                    name: binding.name,
                    slot: binding.texture.binding
                  })
            )
          );

      const targetAbiFingerprint =
        typeof options?.targetAbiFingerprint === 'function'
          ? options.targetAbiFingerprint(input)
          : (options?.targetAbiFingerprint ?? `${stem}-v${version}`);

      const requiredExtensions =
        typeof options?.requiredExtensions === 'function'
          ? Object.freeze(options.requiredExtensions(input))
          : Object.freeze(options?.requiredExtensions ?? EMPTY_LIST);

      return Object.freeze({
        source: emitted.source.replace(/^#version 300 es\s*/, ''),
        bindings: activeBindings,
        physicalBindings,
        programBindings,
        targetAbiFingerprint,
        requiredExtensions,
        sourceMap: EMPTY_SOURCE_MAP,
        translatorFingerprint: `${input.entryPoint}:v${version}`
      });
    }
  });
}
