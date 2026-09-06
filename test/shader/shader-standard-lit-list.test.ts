import { describe, expect, test } from 'vitest';
import {
  STANDARD_LIT_LIST_SHADER_MODULE_KEY,
  STANDARD_LIT_LIST_WEBGL2_TRANSLATOR,
  STANDARD_LIT_LIST_WEBGL_SHADER_MODULE
} from '../../src';

describe('standard-lit LightList built-in shader', () => {
  test('maps the shared environment sampler to every fused WebGL2 texture unit', () => {
    const translated = STANDARD_LIT_LIST_WEBGL2_TRANSLATOR.translate({
      wgsl: STANDARD_LIT_LIST_WEBGL_SHADER_MODULE,
      stage: 'fragment',
      entryPoint: 'standardLitFragment',
      constants: {},
      capabilities: [],
      approvedExtensions: [],
      clipDepthMode: 'vertex-remap'
    });

    expect(STANDARD_LIT_LIST_SHADER_MODULE_KEY).toBe('aether.shader.standard-lit-list.v1');
    expect(
      translated.physicalBindings
        .filter((binding) => binding.kind === 'sampler')
        .map(({ group, binding, slot }) => ({ group, binding, slot }))
    ).toEqual([
      { group: 3, binding: 9, slot: 6 },
      { group: 3, binding: 9, slot: 7 },
      { group: 3, binding: 9, slot: 8 }
    ]);
    expect(
      translated.programBindings
        .filter((binding) => binding.kind === 'combined-sampler' && binding.slot >= 6)
        .map(({ slot }) => slot)
    ).toEqual([6, 7, 8]);
  });
});
