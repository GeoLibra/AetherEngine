import { STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT } from './webgpu/standard-lit-list.generated';
import { STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT } from './webgl2/standard-lit-list.generated';

export const STANDARD_LIT_LIST_SHADER_ABI_VERSION = 3;
export const STANDARD_LIT_LIST_SHADER_MODULE_KEY = 'aether.shader.standard-lit-list.v3';

export const STANDARD_LIT_LIST_WEBGPU_SHADER_MODULE =
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;
export const STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE =
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.modules.wgsl;

export { STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT } from './webgpu/standard-lit-list.generated';
export { STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT } from './webgl2/standard-lit-list.generated';

export {
  mapStandardLitListPhysicalBindings,
  mapStandardLitListProgramBindings
} from './webgl2-bindings';
