import { describe, expect, test } from 'vitest';
import {
  BUILT_IN_WEBGL2_TRANSLATOR,
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_SHADER_MODULE_KEY,
  STANDARD_LIT_LIST_SHADER_ABI_VERSION,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL_SHADER_MODULE,
  createCookedShaderBindingManifest
} from '../../src';

describe('standard-lit LightList built-in shader', () => {
  test('publishes the complete textured StandardLit vertex and material ABI', () => {
    const manifest = createCookedShaderBindingManifest(
      STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT,
      STANDARD_LIT_LIST_SHADER_ABI_VERSION
    );
    expect(manifest.vertexInputs).toEqual([
      { location: 0, name: 'position', type: 'vec3<f32>' },
      { location: 1, name: 'normal', type: 'vec3<f32>' },
      { location: 2, name: 'uv0', type: 'vec2<f32>' },
      { location: 3, name: 'uv1', type: 'vec2<f32>' },
      { location: 4, name: 'tangent', type: 'vec4<f32>' }
    ]);
    expect(
      manifest.groups
        .find(({ group }) => group === 2)
        ?.entries.map(({ kind, binding, name }) => ({ kind, binding, name }))
    ).toEqual([
      { kind: 'uniform-buffer', binding: 0, name: 'materialData' },
      { kind: 'texture', binding: 1, name: 'baseColorTexture' },
      { kind: 'texture', binding: 2, name: 'metallicRoughnessTexture' },
      { kind: 'texture', binding: 3, name: 'normalTexture' },
      { kind: 'texture', binding: 4, name: 'occlusionTexture' },
      { kind: 'texture', binding: 5, name: 'emissiveTexture' },
      { kind: 'sampler', binding: 6, name: 'surfaceSampler' }
    ]);
  });
  test('maps the shared environment sampler to every fused WebGL2 texture unit', () => {
    const translated = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: STANDARD_LIT_LIST_WEBGL_SHADER_MODULE,
      stage: 'fragment',
      entryPoint: 'standardLitFragment',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });

    expect(STANDARD_LIT_LIST_SHADER_MODULE_KEY).toBe('aether.shader.standard-lit-list.v3');
    expect(
      translated.physicalBindings
        .filter((binding) => binding.kind === 'sampler' && binding.group === 3)
        .map(({ group, binding, slot }) => ({ group, binding, slot }))
    ).toEqual([
      { group: 3, binding: 9, slot: 6 },
      { group: 3, binding: 9, slot: 7 },
      { group: 3, binding: 9, slot: 8 },
      { group: 3, binding: 12, slot: 11 }
    ]);
    expect(
      translated.programBindings
        .filter((binding) => binding.kind === 'combined-sampler' && binding.slot >= 6)
        .map(({ slot }) => slot)
    ).toEqual([11, 6, 7, 8]);
  });

  test('publishes the standard PBR v1 profile for both backend artifacts', () => {
    const webgpu = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;
    const webgl =
      STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.modules.glslEs300['fragment:standardLitFragment']!
        .source;

    expect(webgpu).toContain('fn geometrySmithGgx');
    expect(webgpu).not.toContain('fn geometrySchlickGgxDirect');
    expect(webgl).toContain('geometrySmithGgx');
    expect(webgl).not.toContain('geometrySchlickGgxDirect');
    expect(webgpu).toContain('let energyCompensation =');
    expect(webgl).toContain('energyCompensation');
  });
});
