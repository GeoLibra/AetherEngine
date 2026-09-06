import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import { decodeCookedShaderRuntimeArtifact } from '../artifact';
import type { CookedShaderRuntimeArtifact, ShaderAuthoringSource } from '../types';
import { LIGHT_LIST_WEBGL_SHADER_GENERATED_ARTIFACT } from './light-list-webgl.generated';

export const LIGHT_LIST_WEBGL_SHADER_ABI_VERSION = 1;

/** Authored WGSL source identity for the WebGL2 integer-MRT light-list kernel. */
export const LIGHT_LIST_WEBGL_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/light-list-webgl.wgsl',
  languageVersion: 'wgsl-1'
});

/** Creates a WebGL2 translator backed only by validated cooker output. */
export function createLightListWebGL2Translator(
  artifact: CookedShaderRuntimeArtifact
): WebGL2ShaderTranslationPort {
  const validated = decodeCookedShaderRuntimeArtifact(artifact);
  return Object.freeze({
    translatorId: 'aether.light-list.naga-glsl',
    version: LIGHT_LIST_WEBGL_SHADER_ABI_VERSION,
    translate(input: Parameters<WebGL2ShaderTranslationPort['translate']>[0]) {
      if (input.entryPoint !== 'lightListVertex' && input.entryPoint !== 'lightListFragment') {
        throw new Error(`Unsupported WebGL2 light-list entry point "${input.entryPoint}".`);
      }
      const key = `${input.stage}:${input.entryPoint}`;
      const emitted = validated.modules.glslEs300[key];
      const entryPoint = validated.entryPoints.find(
        (entry) => entry.stage === input.stage && entry.name === input.entryPoint
      );
      if (!emitted || !entryPoint)
        throw new Error(`Missing cooked WebGL2 light-list module for "${input.entryPoint}".`);
      const activeBindings = Object.freeze(
        entryPoint.bindings.map((binding) => {
          if (binding.kind !== 'texture')
            throw new Error('WebGL2 light-list only supports cooked texture bindings.');
          return Object.freeze({
            group: binding.group,
            binding: binding.binding,
            name: binding.name,
            kind: 'texture' as const
          });
        })
      );
      const programBindings = Object.freeze(
        emitted.bindings.map((binding) => {
          if (binding.kind !== 'combined-sampler' || binding.sampler !== undefined)
            throw new Error('WebGL2 light-list requires texture-only combined-sampler metadata.');
          return Object.freeze({
            kind: 'combined-sampler' as const,
            name: binding.name,
            slot: binding.texture.binding
          });
        })
      );
      return Object.freeze({
        source: emitted.source.replace(/^#version 300 es\s*/, ''),
        bindings: activeBindings,
        targetAbiFingerprint: `light-list-webgl-v${LIGHT_LIST_WEBGL_SHADER_ABI_VERSION}`,
        physicalBindings: Object.freeze(
          activeBindings.map((binding) => Object.freeze({ ...binding, slot: binding.binding }))
        ),
        programBindings,
        requiredExtensions: EMPTY_REQUIRED_EXTENSIONS,
        sourceMap: EMPTY_TRANSLATED_SOURCE_MAP,
        translatorFingerprint: `${input.entryPoint}:v${LIGHT_LIST_WEBGL_SHADER_ABI_VERSION}`
      });
    }
  });
}

const EMPTY_REQUIRED_EXTENSIONS: readonly string[] = Object.freeze([]);
const EMPTY_TRANSLATED_SOURCE_MAP: readonly Readonly<{
  generatedLine: number;
  authoredLine: number;
}>[] = Object.freeze([]);

/** Versioned cooked shader module for WebGL2 light-list construction. */
export const LIGHT_LIST_WEBGL_SHADER_ARTIFACT = LIGHT_LIST_WEBGL_SHADER_GENERATED_ARTIFACT;
export const LIGHT_LIST_WEBGL_SHADER_MODULE = LIGHT_LIST_WEBGL_SHADER_ARTIFACT.modules.wgsl;
export const LIGHT_LIST_WEBGL2_TRANSLATOR = createLightListWebGL2Translator(
  LIGHT_LIST_WEBGL_SHADER_ARTIFACT
);
