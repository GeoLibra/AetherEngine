import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import { decodeCookedShaderRuntimeArtifact } from '../artifact';
import type { CookedShaderRuntimeArtifact } from '../types';
import { STANDARD_LIT_LIST_WEBGL_SHADER_GENERATED_ARTIFACT } from './standard-lit-list-webgl.generated';
import { STANDARD_LIT_LIST_WEBGPU_SHADER_GENERATED_ARTIFACT } from './standard-lit-list-webgpu.generated';

export const STANDARD_LIT_LIST_SHADER_ABI_VERSION = 1;
export const STANDARD_LIT_LIST_SHADER_MODULE_KEY = 'aether.shader.standard-lit-list.v1';
export const STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT =
  STANDARD_LIT_LIST_WEBGPU_SHADER_GENERATED_ARTIFACT;
export const STANDARD_LIT_LIST_WEBGPU_SHADER_MODULE =
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;
export const STANDARD_LIT_LIST_WEBGL_SHADER_ARTIFACT =
  STANDARD_LIT_LIST_WEBGL_SHADER_GENERATED_ARTIFACT;
export const STANDARD_LIT_LIST_WEBGL_SHADER_MODULE =
  STANDARD_LIT_LIST_WEBGL_SHADER_ARTIFACT.modules.wgsl;

/** Creates the WebGL2 standard-lit LightList translator from validated cooker metadata. */
export function createStandardLitListWebGL2Translator(
  artifact: CookedShaderRuntimeArtifact
): WebGL2ShaderTranslationPort {
  const validated = decodeCookedShaderRuntimeArtifact(artifact);
  return Object.freeze({
    translatorId: 'aether.standard-lit-list.naga-glsl',
    version: STANDARD_LIT_LIST_SHADER_ABI_VERSION,
    translate(input: Parameters<WebGL2ShaderTranslationPort['translate']>[0]) {
      const key = `${input.stage}:${input.entryPoint}`;
      const emitted = validated.modules.glslEs300[key];
      const entryPoint = validated.entryPoints.find(
        (entry) => entry.stage === input.stage && entry.name === input.entryPoint
      );
      if (!emitted || !entryPoint)
        throw new Error(`Missing cooked standard-lit LightList module for "${input.entryPoint}".`);
      const activeBindings = Object.freeze(
        entryPoint.bindings.map((binding) => {
          if (
            binding.kind !== 'uniform-buffer' &&
            binding.kind !== 'texture' &&
            binding.kind !== 'sampler'
          )
            throw new Error(`Unsupported standard-lit LightList binding kind "${binding.kind}".`);
          return Object.freeze({
            group: binding.group,
            binding: binding.binding,
            name: binding.name,
            kind: binding.kind
          });
        })
      );
      const physicalBindings = Object.freeze(
        activeBindings.flatMap((binding) => {
          if (binding.kind !== 'sampler') {
            return [
              Object.freeze({
                ...binding,
                slot: binding.kind === 'uniform-buffer' ? binding.group : binding.binding
              })
            ];
          }
          // A WebGL sampler object is bound to texture units. One authored sampler therefore
          // occupies every unit whose cooked combined sampler references that logical binding.
          return emitted.bindings.flatMap((programBinding) =>
            programBinding.kind === 'combined-sampler' &&
            programBinding.sampler?.group === binding.group &&
            programBinding.sampler.binding === binding.binding
              ? [Object.freeze({ ...binding, slot: programBinding.texture.binding })]
              : []
          );
        })
      );
      const programBindings = Object.freeze(
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
      return Object.freeze({
        source: emitted.source.replace(/^#version 300 es\s*/, ''),
        bindings: activeBindings,
        physicalBindings,
        programBindings,
        targetAbiFingerprint: `standard-lit-list-v${STANDARD_LIT_LIST_SHADER_ABI_VERSION}`,
        requiredExtensions: EMPTY_LIST,
        sourceMap: EMPTY_SOURCE_MAP,
        translatorFingerprint: `${input.entryPoint}:v${STANDARD_LIT_LIST_SHADER_ABI_VERSION}`
      });
    }
  });
}

const EMPTY_LIST: readonly string[] = Object.freeze([]);
const EMPTY_SOURCE_MAP: readonly Readonly<{ generatedLine: number; authoredLine: number }>[] =
  Object.freeze([]);

export const STANDARD_LIT_LIST_WEBGL2_TRANSLATOR = createStandardLitListWebGL2Translator(
  STANDARD_LIT_LIST_WEBGL_SHADER_ARTIFACT
);
