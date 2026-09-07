import type { ShaderAuthoringSource } from '../../types';
import { LIGHT_LIST_SHADER_ARTIFACT } from './webgpu/light-list.generated';
import { LIGHT_LIST_WEBGL2_SHADER_ARTIFACT } from './webgl2/light-list.generated';

export const LIGHT_LIST_SHADER_ABI_VERSION = 2;

/** Authored source identity for the deterministic WebGPU light-list reference kernel. */
export const LIGHT_LIST_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/light-list.wgsl',
  languageVersion: 'wgsl-1'
});

export const LIGHT_LIST_SHADER_MODULE = LIGHT_LIST_SHADER_ARTIFACT.modules.wgsl;

export const LIGHT_LIST_WEBGL2_SHADER_ABI_VERSION = 2;

/** Authored WGSL source identity for the WebGL2 integer-MRT light-list kernel. */
export const LIGHT_LIST_WEBGL2_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/light-list-webgl.wgsl',
  languageVersion: 'wgsl-1'
});

export const LIGHT_LIST_WEBGL2_SHADER_MODULE = LIGHT_LIST_WEBGL2_SHADER_ARTIFACT.modules.wgsl;

// Backward-compatibility aliases for legacy WebGL naming
export const LIGHT_LIST_WEBGL_SHADER_ABI_VERSION = LIGHT_LIST_WEBGL2_SHADER_ABI_VERSION;
export const LIGHT_LIST_WEBGL_SHADER_SOURCE = LIGHT_LIST_WEBGL2_SHADER_SOURCE;
export const LIGHT_LIST_WEBGL_SHADER_MODULE = LIGHT_LIST_WEBGL2_SHADER_MODULE;

export {
  LIGHT_LIST_SHADER_ARTIFACT,
  LIGHT_LIST_SHADER_GENERATED_ARTIFACT
} from './webgpu/light-list.generated';

export {
  LIGHT_LIST_WEBGL2_SHADER_ARTIFACT,
  LIGHT_LIST_WEBGL2_SHADER_GENERATED_ARTIFACT,
  LIGHT_LIST_WEBGL_SHADER_ARTIFACT,
  LIGHT_LIST_WEBGL_SHADER_GENERATED_ARTIFACT
} from './webgl2/light-list.generated';
