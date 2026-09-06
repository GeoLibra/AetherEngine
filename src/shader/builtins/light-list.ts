import type { CookedShaderRuntimeArtifact, ShaderAuthoringSource } from '../types';
import { LIGHT_LIST_SHADER_GENERATED_ARTIFACT } from './light-list.generated';

export const LIGHT_LIST_SHADER_ABI_VERSION = 2;

/** Authored source identity for the deterministic WebGPU light-list reference kernel. */
export const LIGHT_LIST_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/light-list.wgsl',
  languageVersion: 'wgsl-1'
});

/** Cooked and reflected artifact for the built-in WebGPU light-list kernel. */
export const LIGHT_LIST_SHADER_ARTIFACT: CookedShaderRuntimeArtifact =
  LIGHT_LIST_SHADER_GENERATED_ARTIFACT;
export const LIGHT_LIST_SHADER_MODULE = LIGHT_LIST_SHADER_ARTIFACT.modules.wgsl;
