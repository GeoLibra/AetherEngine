import type { ShaderAuthoringSource } from '../../types';
import { SKYBOX_SHADER_ARTIFACT } from './skybox.generated';

export const SKYBOX_SHADER_ABI_VERSION = 2;

/** Authored WGSL source identity for skybox background processing. */
export const SKYBOX_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/skybox.wgsl',
  languageVersion: 'wgsl-1'
});

export const SKYBOX_SHADER_MODULE = SKYBOX_SHADER_ARTIFACT.modules.wgsl;

export { SKYBOX_SHADER_ARTIFACT } from './skybox.generated';
