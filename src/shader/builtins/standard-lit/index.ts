import type { ShaderAuthoringSource } from '../../types';
import { STANDARD_LIT_SHADER_ARTIFACT } from './standard-lit.generated';

export const STANDARD_LIT_SHADER_ABI_VERSION = 2;

/** Authored WGSL source identity used by cook tools and source-mapped diagnostics. */
export const STANDARD_LIT_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/standard-lit.wgsl',
  languageVersion: 'wgsl-1'
});

export const STANDARD_LIT_SHADER_MODULE = STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl;

export { STANDARD_LIT_SHADER_ARTIFACT } from './standard-lit.generated';
