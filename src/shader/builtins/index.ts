export {
  STANDARD_LIT_SHADER_ABI_VERSION,
  STANDARD_LIT_SHADER_MODULE,
  STANDARD_LIT_SHADER_ARTIFACT,
  STANDARD_LIT_SHADER_SOURCE
} from './standard-lit';

export {
  STANDARD_SHADOW_SHADER_ABI_VERSION,
  STANDARD_SHADOW_SHADER_MODULE_KEY,
  STANDARD_SHADOW_SHADER_ARTIFACT,
  STANDARD_SHADOW_SHADER_MODULE
} from './standard-shadow';

export {
  LIGHT_LIST_SHADER_ABI_VERSION,
  LIGHT_LIST_SHADER_ARTIFACT,
  LIGHT_LIST_SHADER_MODULE,
  LIGHT_LIST_SHADER_SOURCE,
  LIGHT_LIST_WEBGL2_SHADER_ABI_VERSION,
  LIGHT_LIST_WEBGL2_SHADER_ARTIFACT,
  LIGHT_LIST_WEBGL2_SHADER_MODULE,
  LIGHT_LIST_WEBGL2_SHADER_SOURCE
} from './light-list';

export {
  CLUSTER_LIGHT_LIST_SHADER_ARTIFACT,
  CLUSTER_LIGHT_LIST_SHADER_MODULE,
  CLUSTER_LIGHT_LIST_SHADER_SOURCE
} from './cluster-light-list';

export {
  POST_COLOR_SHADER_ABI_VERSION,
  POST_COLOR_SHADER_ARTIFACT,
  POST_COLOR_SHADER_MODULE,
  POST_COLOR_SHADER_SOURCE
} from './post-color';

export {
  SKYBOX_SHADER_ABI_VERSION,
  SKYBOX_SHADER_ARTIFACT,
  SKYBOX_SHADER_MODULE,
  SKYBOX_SHADER_SOURCE
} from './skybox';

export {
  STANDARD_LIT_LIST_SHADER_ABI_VERSION,
  STANDARD_LIT_LIST_SHADER_MODULE_KEY,
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGPU_SHADER_MODULE,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
  mapStandardLitListPhysicalBindings,
  mapStandardLitListProgramBindings
} from './standard-lit-list';

export {
  STANDARD_LIT_CLUSTER_SHADER_ABI_VERSION,
  STANDARD_LIT_CLUSTER_SHADER_MODULE_KEY,
  STANDARD_LIT_CLUSTER_WEBGPU_SHADER_ARTIFACT,
  STANDARD_LIT_CLUSTER_WEBGPU_SHADER_MODULE
} from './standard-lit-cluster';

import {
  createWebGL2TranslationRouter,
  type WebGL2ShaderRegistration,
  type WebGL2ShaderTranslationPort
} from '../../rhi/webgl2/shader';
import { LIGHT_LIST_WEBGL2_SHADER_ARTIFACT } from './light-list';
import { POST_COLOR_SHADER_ABI_VERSION, POST_COLOR_SHADER_ARTIFACT } from './post-color';
import { SKYBOX_SHADER_ABI_VERSION, SKYBOX_SHADER_ARTIFACT } from './skybox';
import { STANDARD_LIT_SHADER_ARTIFACT } from './standard-lit';
import {
  STANDARD_SHADOW_SHADER_ABI_VERSION,
  STANDARD_SHADOW_SHADER_ARTIFACT
} from './standard-shadow';
import {
  STANDARD_LIT_LIST_SHADER_ABI_VERSION,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
  mapStandardLitListPhysicalBindings,
  mapStandardLitListProgramBindings
} from './standard-lit-list';

/**
 * Declarative registration table configuring WebGL2 lowering for all engine built-in shaders.
 */
export const BUILT_IN_SHADER_REGISTRATIONS: readonly WebGL2ShaderRegistration[] = Object.freeze([
  Object.freeze({
    artifact: STANDARD_LIT_SHADER_ARTIFACT
  }),
  Object.freeze({
    artifact: STANDARD_SHADOW_SHADER_ARTIFACT,
    webgl2: Object.freeze({
      version: STANDARD_SHADOW_SHADER_ABI_VERSION,
      targetAbiFingerprint: 'standard-shadow-v1'
    })
  }),
  Object.freeze({
    artifact: POST_COLOR_SHADER_ARTIFACT,
    webgl2: Object.freeze({
      version: POST_COLOR_SHADER_ABI_VERSION,
      targetAbiFingerprint: 'post-color-v1'
    })
  }),
  Object.freeze({
    artifact: SKYBOX_SHADER_ARTIFACT,
    webgl2: Object.freeze({
      version: SKYBOX_SHADER_ABI_VERSION,
      targetAbiFingerprint: 'skybox-v1'
    })
  }),
  Object.freeze({
    artifact: LIGHT_LIST_WEBGL2_SHADER_ARTIFACT
  }),
  Object.freeze({
    artifact: STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
    webgl2: Object.freeze({
      version: STANDARD_LIT_LIST_SHADER_ABI_VERSION,
      targetAbiFingerprint: `standard-lit-list-v${STANDARD_LIT_LIST_SHADER_ABI_VERSION}`,
      mapPhysicalBindings: mapStandardLitListPhysicalBindings,
      mapProgramBindings: mapStandardLitListProgramBindings
    })
  })
]);

/**
 * Built-in browser translator routing each recognized built-in WGSL module
 * directly to its corresponding cooked GLSL ES 300 adapter.
 */
export const BUILT_IN_WEBGL2_TRANSLATOR: WebGL2ShaderTranslationPort =
  createWebGL2TranslationRouter(BUILT_IN_SHADER_REGISTRATIONS);

// Re-export RHI WebGL2 lowering router and port for shader callers
export {
  createCookedArtifactWebGL2Translator,
  createWebGL2TranslationRouter,
  type CookedArtifactWebGL2TranslatorOptions,
  type WebGL2RouterRegistrationEntry,
  type WebGL2ShaderModuleRegistration,
  type WebGL2ShaderRegistration,
  type WebGL2ShaderRegistrationOverrides,
  type WebGL2TranslationInput,
  type WebGL2TranslationRouterOptions
} from '../../rhi/webgl2/shader';
