import type { ShaderAuthoringSource } from '../../types';
import { CLUSTER_LIGHT_LIST_SHADER_ARTIFACT } from './webgpu/cluster-light-list.generated';

/** Authored source identity for the deterministic WebGPU clustered-light reference kernel. */
export const CLUSTER_LIGHT_LIST_SHADER_SOURCE: ShaderAuthoringSource = Object.freeze({
  kind: 'wgsl',
  uri: 'asset://aether/builtins/cluster-light-list.wgsl',
  languageVersion: 'wgsl-1'
});

export const CLUSTER_LIGHT_LIST_SHADER_MODULE = CLUSTER_LIGHT_LIST_SHADER_ARTIFACT.modules.wgsl;
export { CLUSTER_LIGHT_LIST_SHADER_ARTIFACT };
