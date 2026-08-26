import { describe, expect, test } from 'vitest';
import {
  STANDARD_LIT_SHADER_ABI_VERSION,
  STANDARD_LIT_SHADER_MODULE,
  createShaderBindingManifest,
  emitGlslEsModule,
  emitWgslModule
} from '../../src';

describe('standard-lit built-in shader', () => {
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
    expect(vertex).toContain('aether_out_normal =');
    expect(fragment).toContain('layout(location = 0) in vec3 aether_in_normal;');
    expect(fragment).toContain('aether_fragment_output =');
    expect(fragment).toContain('lightData.direction');
    expect(fragment).not.toMatch(/@vertex|@fragment|\bfn\b/);
  });
});
