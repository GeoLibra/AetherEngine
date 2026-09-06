import type { WebGL2ShaderTranslationPort } from '../../../rhi/webgl2/types';
import type { CookedShaderRuntimeArtifact } from '../../types';
import { createCookedArtifactWebGL2Translator } from '../cooked-artifact-translator';
import { STANDARD_LIT_LIST_WEBGL2_SHADER_GENERATED_ARTIFACT } from './webgl2/standard-lit-list.generated';
import { STANDARD_LIT_LIST_WEBGPU_SHADER_GENERATED_ARTIFACT } from './webgpu/standard-lit-list.generated';

export const STANDARD_LIT_LIST_SHADER_ABI_VERSION = 1;
export const STANDARD_LIT_LIST_SHADER_MODULE_KEY = 'aether.shader.standard-lit-list.v1';

export const STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT =
  STANDARD_LIT_LIST_WEBGPU_SHADER_GENERATED_ARTIFACT;
export const STANDARD_LIT_LIST_WEBGPU_SHADER_MODULE =
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;

export const STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT =
  STANDARD_LIT_LIST_WEBGL2_SHADER_GENERATED_ARTIFACT;
export const STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE =
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.modules.wgsl;

// Backward-compatibility aliases for legacy WebGL naming
export const STANDARD_LIT_LIST_WEBGL_SHADER_ARTIFACT = STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT;
export const STANDARD_LIT_LIST_WEBGL_SHADER_MODULE = STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE;

/** Creates the WebGL2 standard-lit LightList translator from validated cooker metadata. */
export function createStandardLitListWebGL2Translator(
  artifact: CookedShaderRuntimeArtifact
): WebGL2ShaderTranslationPort {
  return createCookedArtifactWebGL2Translator({
    translatorId: 'aether.standard-lit-list.naga-glsl',
    version: STANDARD_LIT_LIST_SHADER_ABI_VERSION,
    artifact,
    targetAbiFingerprint: `standard-lit-list-v${STANDARD_LIT_LIST_SHADER_ABI_VERSION}`,
    mapPhysicalBindings(activeBindings, emitted) {
      return activeBindings.flatMap((binding) => {
        if (binding.kind !== 'sampler') {
          return [
            Object.freeze({
              ...binding,
              slot: binding.kind === 'uniform-buffer' ? binding.group : binding.binding
            })
          ];
        }
        // A WebGL sampler object is bound to texture units. One authored sampler therefore
        // occupies every unit whose cooked combined sampler references that logical binding.
        return emitted.bindings.flatMap((programBinding) =>
          programBinding.kind === 'combined-sampler' &&
          programBinding.sampler?.group === binding.group &&
          programBinding.sampler.binding === binding.binding
            ? [Object.freeze({ ...binding, slot: programBinding.texture.binding })]
            : []
        );
      });
    }
  });
}

export const STANDARD_LIT_LIST_WEBGL2_TRANSLATOR = createStandardLitListWebGL2Translator(
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT
);
