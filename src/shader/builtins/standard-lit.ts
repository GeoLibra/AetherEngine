import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import { decodeCookedShaderRuntimeArtifact } from '../artifact';
import type { CookedShaderRuntimeArtifact, ShaderAuthoringSource } from '../types';
import { STANDARD_LIT_SHADER_GENERATED_ARTIFACT } from './standard-lit.generated';

export const STANDARD_LIT_SHADER_ABI_VERSION = 2;

/** Authored WGSL source identity used by cook tools and source-mapped diagnostics. */
export const STANDARD_LIT_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/standard-lit.wgsl',
  languageVersion: 'wgsl-1'
});

/**
 * Creates the built-in WebGL2 translation port from a validated cooked artifact.
 * Generated program symbols come exclusively from cook-owned backend metadata.
 *
 * @throws When the artifact or requested standard-lit entry point is invalid.
 */
export function createStandardLitWebGL2Translator(
  artifact: CookedShaderRuntimeArtifact
): WebGL2ShaderTranslationPort {
  const validated = decodeCookedShaderRuntimeArtifact(artifact);
  return Object.freeze({
    translatorId: 'aether.standard-lit.naga-glsl',
    version: STANDARD_LIT_SHADER_ABI_VERSION,
    translate(input: Parameters<WebGL2ShaderTranslationPort['translate']>[0]) {
      if (input.entryPoint !== 'standardLitVertex' && input.entryPoint !== 'standardLitFragment') {
        throw new Error(`Unsupported standard-lit entry point "${input.entryPoint}".`);
      }
      const key = `${input.stage}:${input.entryPoint}`;
      const emitted = validated.modules.glslEs300[key];
      const entryPoint = validated.entryPoints.find(
        (entry) => entry.stage === input.stage && entry.name === input.entryPoint
      );
      if (!emitted || !entryPoint) {
        throw new Error(`Missing cooked standard-lit module for "${input.entryPoint}".`);
      }
      const activeBindings = Object.freeze(
        entryPoint.bindings.map((binding) =>
          Object.freeze({
            group: binding.group,
            binding: binding.binding,
            name: binding.name,
            kind: 'uniform-buffer' as const
          })
        )
      );
      const programBindings = Object.freeze(
        emitted.bindings.map((binding) => {
          if (binding.kind !== 'uniform-buffer') {
            throw new Error('Standard-lit only supports cooked uniform-buffer program bindings.');
          }
          return Object.freeze({
            kind: 'uniform-buffer' as const,
            name: binding.name,
            slot: binding.resource.group
          });
        })
      );
      return Object.freeze({
        // Naga's GLSL backend already applies WGSL-to-OpenGL Y and depth conversion.
        source: emitted.source.replace(/^#version 300 es\s*/, ''),
        bindings: activeBindings,
        targetAbiFingerprint: `standard-lit-v${STANDARD_LIT_SHADER_ABI_VERSION}`,
        physicalBindings: Object.freeze(
          activeBindings.map((binding) => Object.freeze({ ...binding, slot: binding.group }))
        ),
        programBindings,
        requiredExtensions: EMPTY_REQUIRED_EXTENSIONS,
        sourceMap: EMPTY_TRANSLATED_SOURCE_MAP,
        translatorFingerprint: `${input.entryPoint}:v${STANDARD_LIT_SHADER_ABI_VERSION}`
      });
    }
  });
}

const EMPTY_REQUIRED_EXTENSIONS: readonly string[] = Object.freeze([]);
const EMPTY_TRANSLATED_SOURCE_MAP: readonly Readonly<{
  generatedLine: number;
  authoredLine: number;
}>[] = Object.freeze([]);

/** Versioned cooked shader module for the baseline standard-lit material. */
export const STANDARD_LIT_SHADER_ARTIFACT = STANDARD_LIT_SHADER_GENERATED_ARTIFACT;
export const STANDARD_LIT_SHADER_MODULE = STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl;

/** Built-in native WGSL lowering used by the browser baseline WebGL2 path. */
export const STANDARD_LIT_WEBGL2_TRANSLATOR = createStandardLitWebGL2Translator(
  STANDARD_LIT_SHADER_ARTIFACT
);
