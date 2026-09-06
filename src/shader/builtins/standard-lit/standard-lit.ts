import type { WebGL2ShaderTranslationPort } from '../../../rhi/webgl2/types';
import type { CookedShaderRuntimeArtifact, ShaderAuthoringSource } from '../../types';
import { createCookedArtifactWebGL2Translator } from '../cooked-artifact-translator';
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
  return createCookedArtifactWebGL2Translator({
    translatorId: 'aether.standard-lit.naga-glsl',
    version: STANDARD_LIT_SHADER_ABI_VERSION,
    artifact,
    supportedEntryPoints: ['standardLitVertex', 'standardLitFragment'],
    targetAbiFingerprint: `standard-lit-v${STANDARD_LIT_SHADER_ABI_VERSION}`
  });
}

/** Versioned cooked shader module for the baseline standard-lit material. */
export const STANDARD_LIT_SHADER_ARTIFACT = STANDARD_LIT_SHADER_GENERATED_ARTIFACT;
export const STANDARD_LIT_SHADER_MODULE = STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl;

/** Built-in native WGSL lowering used by the browser baseline WebGL2 path. */
export const STANDARD_LIT_WEBGL2_TRANSLATOR = createStandardLitWebGL2Translator(
  STANDARD_LIT_SHADER_ARTIFACT
);
