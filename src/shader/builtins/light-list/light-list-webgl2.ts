import type { WebGL2ShaderTranslationPort } from '../../../rhi/webgl2/types';
import type { CookedShaderRuntimeArtifact, ShaderAuthoringSource } from '../../types';
import { createCookedArtifactWebGL2Translator } from '../cooked-artifact-translator';
import { LIGHT_LIST_WEBGL2_SHADER_GENERATED_ARTIFACT } from './webgl2/light-list.generated';

export const LIGHT_LIST_WEBGL2_SHADER_ABI_VERSION = 2;

/** Authored WGSL source identity for the WebGL2 integer-MRT light-list kernel. */
export const LIGHT_LIST_WEBGL2_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/light-list-webgl.wgsl',
  languageVersion: 'wgsl-1'
});

/** Creates a WebGL2 translator backed only by validated cooker output. */
export function createLightListWebGL2Translator(
  artifact: CookedShaderRuntimeArtifact
): WebGL2ShaderTranslationPort {
  return createCookedArtifactWebGL2Translator({
    translatorId: 'aether.light-list.naga-glsl',
    version: LIGHT_LIST_WEBGL2_SHADER_ABI_VERSION,
    artifact,
    supportedEntryPoints: ['lightListVertex', 'lightListFragment'],
    targetAbiFingerprint: `light-list-webgl-v${LIGHT_LIST_WEBGL2_SHADER_ABI_VERSION}`
  });
}

/** Versioned cooked shader module for WebGL2 light-list construction. */
export const LIGHT_LIST_WEBGL2_SHADER_ARTIFACT = LIGHT_LIST_WEBGL2_SHADER_GENERATED_ARTIFACT;
export const LIGHT_LIST_WEBGL2_SHADER_MODULE = LIGHT_LIST_WEBGL2_SHADER_ARTIFACT.modules.wgsl;
export const LIGHT_LIST_WEBGL2_TRANSLATOR = createLightListWebGL2Translator(
  LIGHT_LIST_WEBGL2_SHADER_ARTIFACT
);

// Backward-compatibility aliases for legacy WebGL naming
export const LIGHT_LIST_WEBGL_SHADER_ABI_VERSION = LIGHT_LIST_WEBGL2_SHADER_ABI_VERSION;
export const LIGHT_LIST_WEBGL_SHADER_SOURCE = LIGHT_LIST_WEBGL2_SHADER_SOURCE;
export const LIGHT_LIST_WEBGL_SHADER_ARTIFACT = LIGHT_LIST_WEBGL2_SHADER_ARTIFACT;
export const LIGHT_LIST_WEBGL_SHADER_MODULE = LIGHT_LIST_WEBGL2_SHADER_MODULE;
