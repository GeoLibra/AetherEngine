import { STANDARD_LIT_CLUSTER_WEBGPU_SHADER_ARTIFACT } from './webgpu/standard-lit-cluster.generated';

/** WebGPU-only forward shader that consumes cluster compute output per fragment. */
export const STANDARD_LIT_CLUSTER_SHADER_ABI_VERSION = 1;
export const STANDARD_LIT_CLUSTER_SHADER_MODULE_KEY = 'aether.shader.standard-lit-cluster.v1';
export const STANDARD_LIT_CLUSTER_WEBGPU_SHADER_MODULE =
  STANDARD_LIT_CLUSTER_WEBGPU_SHADER_ARTIFACT.modules.wgsl;

export { STANDARD_LIT_CLUSTER_WEBGPU_SHADER_ARTIFACT };
