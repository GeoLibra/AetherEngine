import type {
  WebGL2BindingKind,
  WebGL2BindingManifestEntry,
  WebGL2PhysicalBinding,
  WebGL2ProgramBinding,
  WebGL2ShaderTranslationPort
} from '../../rhi/webgl2/types';
import { decodeCookedShaderRuntimeArtifact } from '../artifact';
import type { CookedGlslEs300Module, CookedShaderRuntimeArtifact } from '../types';

export type WebGL2TranslationInput = Parameters<WebGL2ShaderTranslationPort['translate']>[0];

/** Configuration options for the generic cooked artifact WebGL2 translator adapter. */
export interface CookedArtifactWebGL2TranslatorOptions {
  readonly translatorId: string;
  readonly version: number;
  readonly artifact: CookedShaderRuntimeArtifact;
  /** Optional restriction on allowed entry point names. */
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

/**
 * Creates a standard WebGL2 translation port adapter from a validated cooked runtime artifact.
 * Encapsulates binding translation, GLSL header stripping, physical/program slot assignment,
 * and deterministic ABI fingerprints.
 *
 * @throws When requested entry points or bindings are missing or unsupported.
 */
export function createCookedArtifactWebGL2Translator(
  options: CookedArtifactWebGL2TranslatorOptions
): WebGL2ShaderTranslationPort {
  const validated = decodeCookedShaderRuntimeArtifact(options.artifact);
  const supportedEntryPoints = options.supportedEntryPoints
    ? new Set(options.supportedEntryPoints)
    : undefined;

  return Object.freeze({
    translatorId: options.translatorId,
    version: options.version,
    translate(input: WebGL2TranslationInput) {
      if (supportedEntryPoints && !supportedEntryPoints.has(input.entryPoint)) {
        throw new Error(
          `Unsupported entry point "${input.entryPoint}" for translator "${options.translatorId}".`
        );
      }

      const key = `${input.stage}:${input.entryPoint}`;
      const emitted = validated.modules.glslEs300[key];
      const entryPoint = validated.entryPoints.find(
        (entry) => entry.stage === input.stage && entry.name === input.entryPoint
      );

      if (!emitted || !entryPoint) {
        throw new Error(
          `Missing cooked module for "${input.entryPoint}" (stage: "${input.stage}") in translator "${options.translatorId}".`
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

      const physicalBindings: readonly WebGL2PhysicalBinding[] = options.mapPhysicalBindings
        ? Object.freeze(options.mapPhysicalBindings(activeBindings, emitted, input))
        : Object.freeze(
            activeBindings.map((binding) =>
              Object.freeze({
                group: binding.group,
                binding: binding.binding,
                kind: binding.kind,
                slot: binding.kind === 'uniform-buffer' ? binding.group : binding.binding
              })
            )
          );

      const programBindings: readonly WebGL2ProgramBinding[] = options.mapProgramBindings
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
        typeof options.targetAbiFingerprint === 'function'
          ? options.targetAbiFingerprint(input)
          : (options.targetAbiFingerprint ?? `${options.translatorId}-v${options.version}`);

      const requiredExtensions =
        typeof options.requiredExtensions === 'function'
          ? Object.freeze(options.requiredExtensions(input))
          : Object.freeze(options.requiredExtensions ?? EMPTY_LIST);

      return Object.freeze({
        source: emitted.source.replace(/^#version 300 es\s*/, ''),
        bindings: activeBindings,
        physicalBindings,
        programBindings,
        targetAbiFingerprint,
        requiredExtensions,
        sourceMap: EMPTY_SOURCE_MAP,
        translatorFingerprint: `${input.entryPoint}:v${options.version}`
      });
    }
  });
}
