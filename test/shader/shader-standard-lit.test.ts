import { describe, expect, test } from 'vitest';
import {
  STANDARD_LIT_SHADER_ABI_VERSION,
  STANDARD_LIT_SHADER_MODULE,
  STANDARD_LIT_SHADER_SOURCE,
  STANDARD_LIT_WEBGL2_TRANSLATOR,
  AETHER_SHADER_STANDARD_LIBRARY_VERSION,
  cookShaderArtifact,
  createStandardLitShaderResolver,
  createShaderBindingManifest,
  emitGlslEsModule,
  emitWgslModule
} from '../../src';

describe('standard-lit built-in shader', () => {
  test('cooks the authored FluxSL source into the published built-in module', async () => {
    const cooked = await cookShaderArtifact(
      STANDARD_LIT_SHADER_SOURCE,
      createStandardLitShaderResolver(),
      {
        compiler: 1,
        ir: 1,
        abi: STANDARD_LIT_SHADER_ABI_VERSION,
        standardLibrary: AETHER_SHADER_STANDARD_LIBRARY_VERSION
      }
    );

    expect(cooked.source.uri).toBe('asset://aether/builtins/standard-lit.flux');
    expect(cooked.dependencies.map(({ uri }) => uri)).toEqual([
      'asset://aether/builtins/standard-lit.flux'
    ]);
    expect(emitWgslModule(cooked.ir)).toBe(emitWgslModule(STANDARD_LIT_SHADER_MODULE));
    expect(emitGlslEsModule(cooked.ir, 'standardLitFragment')).toBe(
      emitGlslEsModule(STANDARD_LIT_SHADER_MODULE, 'standardLitFragment')
    );
    expect(cooked.ir.sourceClosureHash).toBe(STANDARD_LIT_SHADER_MODULE.sourceClosureHash);
    expect(cooked.ir.sourceMap.spans.every(({ uri }) => uri === cooked.source.uri)).toBe(true);
  });

  test('publishes the canonical object, view, material, and light ABI', () => {
    const manifest = createShaderBindingManifest(
      STANDARD_LIT_SHADER_MODULE,
      STANDARD_LIT_SHADER_ABI_VERSION
    );

    expect(manifest.vertexInputs).toEqual([
      { location: 0, name: 'position', type: 'vec3<f32>' },
      { location: 1, name: 'normal', type: 'vec3<f32>' }
    ]);
    expect(
      manifest.groups.map(({ group, entries }) => ({
        group,
        entries: entries.map(({ kind, binding, name }) => ({ kind, binding, name }))
      }))
    ).toEqual([
      { group: 0, entries: [{ kind: 'uniform-buffer', binding: 0, name: 'objectData' }] },
      { group: 1, entries: [{ kind: 'uniform-buffer', binding: 0, name: 'viewData' }] },
      { group: 2, entries: [{ kind: 'uniform-buffer', binding: 0, name: 'materialData' }] },
      { group: 3, entries: [{ kind: 'uniform-buffer', binding: 0, name: 'lightData' }] }
    ]);
    expect(manifest.fragmentOutputs).toEqual([
      { location: 0, name: 'standardLitFragment', type: 'vec4<f32>' }
    ]);
  });

  test('deterministically lowers the same typed module to WGSL and GLSL ES', () => {
    const wgsl = emitWgslModule(STANDARD_LIT_SHADER_MODULE);
    const vertex = emitGlslEsModule(STANDARD_LIT_SHADER_MODULE, 'standardLitVertex');
    const fragment = emitGlslEsModule(STANDARD_LIT_SHADER_MODULE, 'standardLitFragment');

    expect(emitWgslModule(STANDARD_LIT_SHADER_MODULE)).toBe(wgsl);
    expect(wgsl).toContain('@builtin(position) position: vec4<f32>');
    expect(wgsl).toContain('@location(0) normal: vec3<f32>');
    expect(wgsl).toContain('@group(3) @binding(0) var<uniform> lightData');
    expect(vertex).toContain('gl_Position =');
    expect(vertex).toContain('out vec3 aether_varying_normal;');
    expect(vertex).toContain('aether_varying_normal =');
    expect(fragment).toContain('in vec3 aether_varying_normal;');
    expect(fragment).toContain('aether_fragment_output =');
    expect(fragment).toContain('lightData.direction');
    expect(fragment).not.toMatch(/@vertex|@fragment|\bfn\b/);
  });

  test('applies the WebGL2 zero-to-one depth compatibility epilogue when required', () => {
    const translated = STANDARD_LIT_WEBGL2_TRANSLATOR.translate({
      wgsl: emitWgslModule(STANDARD_LIT_SHADER_MODULE),
      stage: 'vertex',
      entryPoint: 'standardLitVertex',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });

    expect(translated.source).toContain('gl_Position.z = 2.0 * gl_Position.z - gl_Position.w;');
  });
});
