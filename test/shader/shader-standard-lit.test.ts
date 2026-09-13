import { describe, expect, test } from 'vitest';
import {
  STANDARD_LIT_SHADER_ABI_VERSION,
  STANDARD_LIT_SHADER_ARTIFACT,
  STANDARD_LIT_SHADER_MODULE,
  STANDARD_LIT_SHADER_SOURCE,
  BUILT_IN_WEBGL2_TRANSLATOR,
  createCookedArtifactWebGL2Translator,
  createCookedShaderBindingManifest
} from '../../src';

describe('standard-lit built-in shader', () => {
  test('publishes a native-cooked WGSL artifact', () => {
    expect(STANDARD_LIT_SHADER_SOURCE).toEqual({
      kind: 'wgsl',
      uri: 'asset://aether/builtins/standard-lit.wgsl',
      languageVersion: 'wgsl-1'
    });
    expect(STANDARD_LIT_SHADER_ARTIFACT.sourceKind).toBe('wgsl');
    expect(STANDARD_LIT_SHADER_ARTIFACT.source.sourceUri).toBe(STANDARD_LIT_SHADER_SOURCE.uri);
    expect(STANDARD_LIT_SHADER_ARTIFACT.toolchain.nagaVersion).toBeTruthy();
    expect(STANDARD_LIT_SHADER_MODULE).toBe(STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl);
    expect(
      STANDARD_LIT_SHADER_ARTIFACT.entryPoints.map(({ name, stage }) => ({ name, stage }))
    ).toEqual([
      { name: 'standardLitVertex', stage: 'vertex' },
      { name: 'standardLitFragment', stage: 'fragment' }
    ]);
  });

  test('publishes the canonical object, view, material, and light ABI', () => {
    const manifest = createCookedShaderBindingManifest(
      STANDARD_LIT_SHADER_ARTIFACT,
      STANDARD_LIT_SHADER_ABI_VERSION
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
      manifest.groups.map(({ group, entries }) => ({
        group,
        entries: entries.map(({ kind, binding, name }) => ({ kind, binding, name }))
      }))
    ).toEqual([
      { group: 0, entries: [{ kind: 'uniform-buffer', binding: 0, name: 'objectData' }] },
      { group: 1, entries: [{ kind: 'uniform-buffer', binding: 0, name: 'viewData' }] },
      {
        group: 2,
        entries: [
          { kind: 'uniform-buffer', binding: 0, name: 'materialData' },
          { kind: 'texture', binding: 1, name: 'baseColorTexture' },
          { kind: 'texture', binding: 2, name: 'metallicRoughnessTexture' },
          { kind: 'texture', binding: 3, name: 'normalTexture' },
          { kind: 'texture', binding: 4, name: 'occlusionTexture' },
          { kind: 'texture', binding: 5, name: 'emissiveTexture' },
          { kind: 'sampler', binding: 6, name: 'surfaceSampler' }
        ]
      },
      { group: 3, entries: [{ kind: 'uniform-buffer', binding: 0, name: 'lightData' }] }
    ]);
    expect(manifest.fragmentOutputs).toEqual([
      { location: 0, name: 'standardLitFragment', type: 'vec4<f32>' }
    ]);
    expect(manifest.buffers.find(({ name }) => name === 'objectData')).toMatchObject({
      byteSize: 128,
      fields: [
        { path: 'world', offset: 0 },
        { path: 'normalWorld', offset: 64 }
      ]
    });
    expect(manifest.buffers.find(({ name }) => name === 'viewData')).toMatchObject({
      byteSize: 80,
      fields: [
        { path: 'viewProjection', offset: 0 },
        { path: 'cameraPosition', offset: 64 }
      ]
    });
    expect(manifest.buffers.find(({ name }) => name === 'materialData')).toMatchObject({
      byteSize: 240,
      fields: [
        { path: 'baseColor', offset: 0 },
        { path: 'emissiveFactor', offset: 16 },
        { path: 'normalScale', offset: 28 },
        { path: 'metallic', offset: 32 },
        { path: 'roughness', offset: 36 },
        { path: 'occlusionStrength', offset: 40 },
        { path: 'alphaCutoff', offset: 44 },
        { path: 'baseColorUvSet', offset: 48 },
        { path: 'metallicRoughnessUvSet', offset: 52 },
        { path: 'normalUvSet', offset: 56 },
        { path: 'occlusionUvSet', offset: 60 },
        { path: 'emissiveUvSet', offset: 64 },
        { path: 'alphaMask', offset: 68 },
        { path: 'baseColorTransform', offset: 80 },
        { path: 'baseColorOffset', offset: 96 },
        { path: 'metallicRoughnessTransform', offset: 112 },
        { path: 'metallicRoughnessOffset', offset: 128 },
        { path: 'normalTransform', offset: 144 },
        { path: 'normalOffset', offset: 160 },
        { path: 'occlusionTransform', offset: 176 },
        { path: 'occlusionOffset', offset: 192 },
        { path: 'emissiveTransform', offset: 208 },
        { path: 'emissiveOffset', offset: 224 }
      ]
    });
    expect(manifest.buffers.find(({ name }) => name === 'lightData')).toMatchObject({
      byteSize: 32,
      fields: [
        { path: 'direction', offset: 0 },
        { path: 'illuminance', offset: 12 },
        { path: 'color', offset: 16 }
      ]
    });
  });

  test('publishes the standard PBR v1 GGX, Smith, and Schlick terms', () => {
    const wgsl = STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl;
    const fragment = STANDARD_LIT_SHADER_ARTIFACT.modules.glslEs300['fragment:standardLitFragment'];
    expect(wgsl).toContain('fn distributionGgx');
    expect(wgsl).toContain('fn geometrySmithGgx');
    expect(wgsl).not.toContain('fn geometrySchlickGgxDirect');
    expect(wgsl).toContain('fn geometrySmith');
    expect(wgsl).toContain('fn fresnelSchlick');
    expect(wgsl).toContain('materialData.metallic');
    expect(wgsl).toContain('materialData.roughness');
    expect(wgsl).toContain('objectData.normalWorld');
    expect(fragment?.source).toContain('_group_2_binding_0_fs.metallic');
    expect(fragment?.source).not.toMatch(/@vertex|@fragment|\bfn\b/);
  });

  test('uses Naga GLSL block names and applies clip conversion exactly once', () => {
    const translated = BUILT_IN_WEBGL2_TRANSLATOR.translate({
      wgsl: STANDARD_LIT_SHADER_MODULE,
      stage: 'vertex',
      entryPoint: 'standardLitVertex',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });
    expect(translated.source).not.toMatch(/^#version/m);
    expect(translated.source.match(/gl_Position\.yz =/g)).toHaveLength(1);
    expect(translated.source).not.toContain('gl_Position.z = 2.0 * gl_Position.z - gl_Position.w;');
    expect(translated.programBindings).toEqual([
      { kind: 'uniform-buffer', name: 'ObjectData_block_0Vertex', slot: 0 },
      { kind: 'uniform-buffer', name: 'ViewData_block_1Vertex', slot: 1 }
    ]);
  });

  test('uses cooked binding metadata without inspecting GLSL declarations', () => {
    const vertexModule =
      STANDARD_LIT_SHADER_ARTIFACT.modules.glslEs300['vertex:standardLitVertex']!;
    const translator = createCookedArtifactWebGL2Translator({
      artifact: {
        ...STANDARD_LIT_SHADER_ARTIFACT,
        modules: {
          ...STANDARD_LIT_SHADER_ARTIFACT.modules,
          glslEs300: {
            ...STANDARD_LIT_SHADER_ARTIFACT.modules.glslEs300,
            'vertex:standardLitVertex': {
              ...vertexModule,
              source: '#version 300 es\nvoid main() {}'
            }
          }
        }
      }
    });

    const translated = translator.translate({
      wgsl: STANDARD_LIT_SHADER_MODULE,
      stage: 'vertex',
      entryPoint: 'standardLitVertex',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });

    expect(translated.programBindings).toEqual([
      { kind: 'uniform-buffer', name: 'ObjectData_block_0Vertex', slot: 0 },
      { kind: 'uniform-buffer', name: 'ViewData_block_1Vertex', slot: 1 }
    ]);
  });
});
