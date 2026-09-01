import type { WebGL2ShaderTranslationPort } from '../../rhi/webgl2/types';
import type { ShaderAuthoringSource } from '../types';
import { STANDARD_LIT_SHADER_GENERATED_ARTIFACT } from './standard-lit.generated';

export const STANDARD_LIT_SHADER_ABI_VERSION = 2;

/** Authored WGSL source identity used by cook tools and source-mapped diagnostics. */
export const STANDARD_LIT_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/standard-lit.wgsl',
  languageVersion: 'wgsl-1'
});

const STANDARD_LIT_WEBGL2_BINDINGS = Object.freeze(
  ['objectData', 'viewData', 'materialData', 'lightData'].map((name, group) =>
    Object.freeze({ group, binding: 0, name, kind: 'uniform-buffer' as const })
  )
);

/** Built-in native WGSL lowering used by the browser baseline WebGL2 path. */
export const STANDARD_LIT_WEBGL2_TRANSLATOR: WebGL2ShaderTranslationPort = Object.freeze({
  translatorId: 'aether.standard-lit.naga-glsl',
  version: STANDARD_LIT_SHADER_ABI_VERSION,
  translate(input: Parameters<WebGL2ShaderTranslationPort['translate']>[0]) {
    if (input.entryPoint !== 'standardLitVertex' && input.entryPoint !== 'standardLitFragment') {
      throw new Error(`Unsupported standard-lit entry point "${input.entryPoint}".`);
    }
    const emitted =
      STANDARD_LIT_SHADER_ARTIFACT.modules.glslEs300[`${input.stage}:${input.entryPoint}`];
    if (!emitted) throw new Error(`Missing cooked standard-lit module for "${input.entryPoint}".`);
    // Naga's GLSL backend already applies WGSL-to-OpenGL Y and depth conversion.
    const source = emitted.replace(/^#version 300 es\s*/, '');
    const activeBindings = STANDARD_LIT_WEBGL2_BINDINGS.filter((binding) =>
      source.includes(`_group_${binding.group}_binding_${binding.binding}_`)
    );
    return Object.freeze({
      source,
      bindings: activeBindings,
      targetAbiFingerprint: `standard-lit-v${STANDARD_LIT_SHADER_ABI_VERSION}`,
      physicalBindings: Object.freeze(
        activeBindings.map((binding) => Object.freeze({ ...binding, slot: binding.group }))
      ),
      programBindings: Object.freeze(reflectUniformBlockBindings(source, activeBindings)),
      requiredExtensions: EMPTY_REQUIRED_EXTENSIONS,
      sourceMap: EMPTY_TRANSLATED_SOURCE_MAP,
      translatorFingerprint: `${input.entryPoint}:v${STANDARD_LIT_SHADER_ABI_VERSION}`
    });
  }
});

function reflectUniformBlockBindings(
  source: string,
  bindings: typeof STANDARD_LIT_WEBGL2_BINDINGS
) {
  return bindings.map((binding) => {
    const variable = `_group_${binding.group}_binding_${binding.binding}_`;
    const blockPattern = new RegExp(`uniform\\s+([A-Za-z_][A-Za-z0-9_]*)\\s*\\{[^}]*${variable}`);
    const blockName = blockPattern.exec(source)?.[1];
    if (!blockName) {
      throw new Error(
        `Missing cooked WebGL2 uniform block for group ${binding.group}, binding ${binding.binding}.`
      );
    }
    return Object.freeze({
      kind: 'uniform-buffer' as const,
      name: blockName,
      slot: binding.group
    });
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
