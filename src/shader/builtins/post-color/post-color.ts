import type { WebGL2ShaderTranslationPort } from '../../../rhi/webgl2/types';
import type { CookedShaderRuntimeArtifact, ShaderAuthoringSource } from '../../types';
import { createCookedArtifactWebGL2Translator } from '../cooked-artifact-translator';
import { POST_COLOR_SHADER_GENERATED_ARTIFACT } from './post-color.generated';

export const POST_COLOR_SHADER_ABI_VERSION = 1;

/** Authored WGSL source identity for post-color processing. */
export const POST_COLOR_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/post-color.wgsl',
  languageVersion: 'wgsl-1'
});

export const POST_COLOR_SHADER_ARTIFACT: CookedShaderRuntimeArtifact =
  POST_COLOR_SHADER_GENERATED_ARTIFACT;
export const POST_COLOR_SHADER_MODULE = POST_COLOR_SHADER_ARTIFACT.modules.wgsl;

/** Creates a WebGL2 translator for post-color processing. */
export function createPostColorWebGL2Translator(
  artifact: CookedShaderRuntimeArtifact
): WebGL2ShaderTranslationPort {
  return createCookedArtifactWebGL2Translator({
    translatorId: 'aether.post-color.naga-glsl',
    version: POST_COLOR_SHADER_ABI_VERSION,
    artifact,
    supportedEntryPoints: ['postColorVertex', 'postColorFragment'],
    targetAbiFingerprint: 'post-color-v1'
  });
}

/** Uses the committed Naga output for the versioned baseline output transform. */
export const POST_COLOR_WEBGL2_TRANSLATOR: WebGL2ShaderTranslationPort =
  createPostColorWebGL2Translator(POST_COLOR_SHADER_ARTIFACT);
