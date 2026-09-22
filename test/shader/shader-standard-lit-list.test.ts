import { describe, expect, test } from 'vitest';
import {
  BUILT_IN_WEBGL2_TRANSLATOR,
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_SHADER_MODULE_KEY,
  STANDARD_LIT_LIST_SHADER_ABI_VERSION,
  STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
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
      { location: 4, name: 'tangent', type: 'vec4<f32>' },
      { location: 5, name: 'color0', type: 'vec4<f32>' }
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
    expect(
      STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.bufferLayouts.find(
        (layout) => layout.name === 'viewData'
      )
    ).toMatchObject({
      byteSize: 144,
      fields: [
        { path: 'viewProjection', offset: 0 },
        { path: 'view', offset: 64 },
        { path: 'cameraPosition', offset: 128 }
      ]
    });
  });
  test('maps the shared environment sampler to every fused WebGL2 texture unit', () => {
    const translated = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
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
      { group: 3, binding: 9, slot: 10 },
      { group: 3, binding: 9, slot: 11 },
      { group: 3, binding: 9, slot: 12 },
      { group: 3, binding: 12, slot: 13 }
    ]);
    expect(
      translated.programBindings
        .filter((binding) => binding.kind === 'combined-sampler' && binding.slot >= 6)
        .map(({ slot }) => slot)
    ).toEqual([13, 6, 7, 8, 9, 10, 11, 12]);
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

  test('keeps the local spot and point shadow receiver ABI live in the forward shader', () => {
    const webgpu = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;
    const fragmentBindings = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.entryPoints.find(
      (entryPoint) => entryPoint.name === 'standardLitFragment'
    )?.bindings;

    expect(fragmentBindings).toContainEqual(
      expect.objectContaining({
        group: 3,
        binding: 13,
        name: 'localShadowReceiverData',
        kind: 'uniform-buffer'
      })
    );
    expect(webgpu).toContain('fn localShadowVisibility');
    expect(webgpu).toContain('metadata.z + face');
    expect(webgpu).toContain(
      'textureSampleCompareLevel(directionalShadowMap, directionalShadowSampler'
    );
    expect(webgpu).toContain('if (metadata.y == 1u)');
  });

  test('allocates the complete 16-word spot-capable light record capacity', () => {
    expect(STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl).toContain(
      'array<vec4<u32>, 1025>'
    );
  });
});
