import { describe, expect, test } from 'vitest';
import {
  STANDARD_SHADOW_SHADER_ABI_VERSION,
  STANDARD_SHADOW_SHADER_ARTIFACT,
  createCookedShaderBindingManifest
} from '../../src';

describe('standard-shadow built-in shader', () => {
  test('preserves both UV sets for alpha-mask shadow coverage', () => {
    const manifest = createCookedShaderBindingManifest(
      STANDARD_SHADOW_SHADER_ARTIFACT,
      STANDARD_SHADOW_SHADER_ABI_VERSION
    );

    expect(manifest.vertexInputs).toEqual([
      { location: 0, name: 'position', type: 'vec3<f32>' },
      { location: 2, name: 'uv0', type: 'vec2<f32>' },
      { location: 3, name: 'uv1', type: 'vec2<f32>' }
    ]);

    const wgsl = STANDARD_SHADOW_SHADER_ARTIFACT.modules.wgsl;
    const fragment =
      STANDARD_SHADOW_SHADER_ARTIFACT.modules.glslEs300['fragment:standardShadowFragment'];
    expect(wgsl).toContain('select(input.uv0, input.uv1, shadowMaterialData.baseColorUvSet == 1u)');
    expect(fragment?.source).toContain('baseColorUvSet');
  });
});
