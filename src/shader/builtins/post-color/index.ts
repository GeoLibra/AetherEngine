import type { ShaderAuthoringSource } from '../../types';
import { POST_COLOR_SHADER_ARTIFACT } from './post-color.generated';

export const POST_COLOR_SHADER_ABI_VERSION = 1;

/** Authored WGSL source identity for post-color processing. */
export const POST_COLOR_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/post-color.wgsl',
  languageVersion: 'wgsl-1'
});

export const POST_COLOR_SHADER_MODULE = POST_COLOR_SHADER_ARTIFACT.modules.wgsl;

export { POST_COLOR_SHADER_ARTIFACT } from './post-color.generated';
