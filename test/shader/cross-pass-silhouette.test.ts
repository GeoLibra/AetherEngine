/**
 * @file Cross-pass structural coverage and shared-module contract tests.
 * Asserts at the WGSL-structure level that shadow caster, lit, skybox, post and light culling
 * passes share identical utility, surface, BRDF, tone mapping, fullscreen, and geometry modules.
 *
 * NOTE: This suite is a STRUCTURAL coverage contract only. Rendered lit/shadow silhouette
 * conformance in deterministic GPU scenes is a deferred acceptance gate (see
 * engine/design/v2/04-rendering/14-shader-modules.md section 7); no offscreen GPU/readback or
 * visual golden run executes here, so texture binding, UV interpolation, sampler and pass
 * wiring differences are not yet asserted.
 */

import { describe, expect, it } from 'vitest';
import { STANDARD_SHADOW_SHADER_ARTIFACT } from '../../src/shader/builtins/standard-shadow';
import { STANDARD_LIT_SHADER_ARTIFACT } from '../../src/shader/builtins/standard-lit';
import {
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT
} from '../../src/shader/builtins/standard-lit-list';
import { POST_COLOR_SHADER_ARTIFACT } from '../../src/shader/builtins/post-color';
import { SKYBOX_SHADER_ARTIFACT } from '../../src/shader/builtins/skybox';
import {
  LIGHT_LIST_SHADER_ARTIFACT,
  LIGHT_LIST_WEBGL2_SHADER_ARTIFACT
} from '../../src/shader/builtins/light-list';
import {
  createStandardLitMaterial,
  packBaselineMaterialUniform,
  packBaselineShadowMaterialUniform,
  STANDARD_LIT_MATERIAL_WORD_OFFSETS,
  STANDARD_SHADOW_MATERIAL_WORD_OFFSETS
} from '../../src';

describe('Cross-Pass Structural Coverage & Shared Module Contract', () => {
  it('shadow and lit passes include identical evaluateAlphaCoverage logic in cooked artifacts', () => {
    const shadowWgsl = STANDARD_SHADOW_SHADER_ARTIFACT.modules.wgsl;
    const litWgsl = STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl;
    const litListWebGpu = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;

    // Verify WebGPU/both WGSL artifacts contain the shared evaluateAlphaCoverage predicate
    expect(shadowWgsl).toContain('fn evaluateAlphaCoverage');
    expect(litWgsl).toContain('fn evaluateAlphaCoverage');
    expect(litListWebGpu).toContain('fn evaluateAlphaCoverage');
    // WebGL2-only target emits GLSL ES 300 per entry point (keyed by stage:entryName)
    expect(
      STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.modules.glslEs300['fragment:standardLitFragment']
        ?.source
    ).toContain('evaluateAlphaCoverage');

    // Verify all cooked artifacts contain the shared transformUv function
    expect(shadowWgsl).toContain('fn transformUv');
    expect(litWgsl).toContain('fn transformUv');
    expect(litListWebGpu).toContain('fn transformUv');
    expect(
      STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.modules.glslEs300['vertex:standardLitVertex']?.source
    ).toContain('transformUv');
  });

  it('preserves parameter ABI parity between lit and shadow material uniform writers', () => {
    const material = createStandardLitMaterial({
      baseColor: [0.75, 0.5, 0.25, 0.8],
      alphaCutoff: 0.33,
      alphaMode: 'mask'
    });

    const litPacked = packBaselineMaterialUniform(material);
    const shadowPacked = packBaselineShadowMaterialUniform(material);

    const litFloats = new Float32Array(litPacked.buffer, litPacked.byteOffset, litPacked.length);
    const shadowFloats = new Float32Array(
      shadowPacked.buffer,
      shadowPacked.byteOffset,
      shadowPacked.length
    );

    // Assert baseColorFactor / baseColor alignment
    expect(shadowFloats[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorFactor]).toBeCloseTo(0.75);
    expect(shadowFloats[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorFactor + 1]).toBeCloseTo(
      0.5
    );
    expect(shadowFloats[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorFactor + 2]).toBeCloseTo(
      0.25
    );
    expect(shadowFloats[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorFactor + 3]).toBeCloseTo(
      0.8
    );
    expect(litFloats[STANDARD_LIT_MATERIAL_WORD_OFFSETS.baseColor + 3]).toBeCloseTo(
      shadowFloats[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorFactor + 3]!
    );

    // Assert alphaCutoff alignment
    expect(shadowFloats[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.alphaCutoff]).toBeCloseTo(0.33);
    expect(litFloats[STANDARD_LIT_MATERIAL_WORD_OFFSETS.alphaCutoff]).toBeCloseTo(
      shadowFloats[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.alphaCutoff]!
    );

    // Assert alphaMask alignment
    expect(shadowPacked[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.alphaMask]).toBe(1);
    expect(litPacked[STANDARD_LIT_MATERIAL_WORD_OFFSETS.alphaMask]).toBe(1);

    // Assert baseColorUvSet alignment
    expect(shadowPacked[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorUvSet]).toBe(
      litPacked[STANDARD_LIT_MATERIAL_WORD_OFFSETS.baseColorUvSet]
    );

    // Assert baseColorTransform and baseColorOffset alignment
    for (let i = 0; i < 4; i++) {
      expect(
        shadowFloats[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorTransform + i]
      ).toBeCloseTo(litFloats[STANDARD_LIT_MATERIAL_WORD_OFFSETS.baseColorTransform + i]!);
    }
    for (let i = 0; i < 2; i++) {
      expect(shadowFloats[STANDARD_SHADOW_MATERIAL_WORD_OFFSETS.baseColorOffset + i]).toBeCloseTo(
        litFloats[STANDARD_LIT_MATERIAL_WORD_OFFSETS.baseColorOffset + i]!
      );
    }
  });

  it('enforces exact structural coverage discard conditions in lit and shadow shader artifacts', () => {
    const shadowWgsl = STANDARD_SHADOW_SHADER_ARTIFACT.modules.wgsl;
    const litWgsl = STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl;
    const litListWebGpu = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;
    const litListWebGlFragment =
      STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.modules.glslEs300['fragment:standardLitFragment']
        ?.source;

    // 1. Both passes call evaluateAlphaCoverage with (alpha, cutoff, alphaMask)
    expect(shadowWgsl).toMatch(
      /evaluateAlphaCoverage\s*\(\s*alpha\s*,\s*shadowMaterialData\.alphaCutoff\s*,\s*shadowMaterialData\.alphaMask\s*\)/
    );
    expect(litWgsl).toMatch(
      /evaluateAlphaCoverage\s*\(\s*surface\.baseColor\.a\s*,\s*materialData\.alphaCutoff\s*,\s*materialData\.alphaMask\s*\)/
    );
    expect(litListWebGpu).toMatch(
      /evaluateAlphaCoverage\s*\(\s*surface\.baseColor\.a\s*,\s*materialData\.alphaCutoff\s*,\s*materialData\.alphaMask\s*\)/
    );
    expect(litListWebGlFragment).toContain('evaluateAlphaCoverage');

    // 2. Both passes discard when evaluateAlphaCoverage evaluates to false
    expect(shadowWgsl).toMatch(/if\s*\(\s*!evaluateAlphaCoverage[^{]+\)\s*\{\s*discard;\s*\}/);
    expect(litWgsl).toMatch(/if\s*\(\s*!evaluateAlphaCoverage[^{]+\)\s*\{\s*discard;\s*\}/);
    expect(litListWebGpu).toMatch(/if\s*\(\s*!evaluateAlphaCoverage[^{]+\)\s*\{\s*discard;\s*\}/);

    // 3. evaluateAlphaCoverage predicate definition in linked artifacts enforces cutoff threshold when alphaMask != 0u
    const coverageDefinition =
      /fn evaluateAlphaCoverage\s*\(\s*alpha:\s*f32,\s*alphaCutoff:\s*f32,\s*alphaMask:\s*u32\s*\)\s*->\s*bool\s*\{[\s\S]*?if\s*\(\s*alphaMask\s*!=\s*0u\s*&&\s*alpha\s*<\s*alphaCutoff\s*\)\s*\{\s*return false;\s*\}[\s\S]*?return true;\s*\}/;
    expect(shadowWgsl).toMatch(coverageDefinition);
    expect(litWgsl).toMatch(coverageDefinition);
    expect(litListWebGpu).toMatch(coverageDefinition);
  });

  it('shadow caster pass does not leak BRDF, IBL, or surface normal evaluation', () => {
    const shadowWgsl = STANDARD_SHADOW_SHADER_ARTIFACT.modules.wgsl;

    // Shadow caster only needs UV and Alpha coverage; it must NOT contain BRDF math or IBL
    expect(shadowWgsl).not.toContain('cookTorranceDirect');
    expect(shadowWgsl).not.toContain('distributionGgx');
    expect(shadowWgsl).not.toContain('evaluateIbl');
    expect(shadowWgsl).not.toContain('sampleStandardLitSurface');
    expect(shadowWgsl).not.toContain('acesFitted');
    expect(shadowWgsl).not.toContain('directionToEquirectangularUv');
  });

  it('lit passes contain Cook-Torrance BRDF and microfacet functions from shared module', () => {
    const litWgsl = STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl;
    const litListWgsl = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;

    expect(litWgsl).toContain('fn cookTorranceDirect');
    expect(litWgsl).toContain('fn distributionGgx');
    expect(litWgsl).toContain('fn geometrySmith');
    expect(litWgsl).toContain('fn fresnelSchlick');

    expect(litListWgsl).toContain('fn cookTorranceDirect');
    expect(litListWgsl).toContain('fn distributionGgx');
    expect(litListWgsl).toContain('fn geometrySmith');
    expect(litListWgsl).toContain('fn fresnelSchlick');
  });

  it('lit passes share sampleStandardLitSurface from surface/standard module', () => {
    const litWgsl = STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl;
    const litListWgsl = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;
    const litListWebGlFragment =
      STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.modules.glslEs300['fragment:standardLitFragment']
        ?.source;

    expect(litWgsl).toContain('fn sampleStandardLitSurface');
    expect(litListWgsl).toContain('fn sampleStandardLitSurface');
    expect(litListWebGlFragment).toContain('sampleStandardLitSurface');
  });

  it('lit-list passes contain IBL and shadow receiver functions from shared modules', () => {
    const litListWgsl = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;
    const litListWebGlFragment =
      STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.modules.glslEs300['fragment:standardLitFragment']
        ?.source;

    // IBL module functions linked into lit-list cooked artifacts
    expect(litListWgsl).toContain('fn evaluateIbl');
    expect(litListWgsl).toContain('fn directionToEquirectangularUv');
    expect(litListWgsl).toContain('fn evaluateSurfaceIbl');
    expect(litListWebGlFragment).toContain('evaluateIbl');
    expect(litListWebGlFragment).toContain('directionToEquirectangularUv');

    // Shadow receiver module function linked into lit-list cooked artifacts
    expect(litListWgsl).toContain('fn directionalShadowVisibility');
    expect(litListWebGlFragment).toContain('directionalShadowVisibility');
  });

  it('post pass links tone mapping module and skybox links equirectangular module', () => {
    const postColorWgsl = POST_COLOR_SHADER_ARTIFACT.modules.wgsl;
    const skyboxWgsl = SKYBOX_SHADER_ARTIFACT.modules.wgsl;

    expect(postColorWgsl).toContain('fn acesFitted');
    expect(skyboxWgsl).toContain('fn directionToEquirectangularUv');
  });

  it('fullscreen passes share the fullscreen triangle module', () => {
    const postColorWgsl = POST_COLOR_SHADER_ARTIFACT.modules.wgsl;
    const skyboxWgsl = SKYBOX_SHADER_ARTIFACT.modules.wgsl;
    const lightListWebGlVertex =
      LIGHT_LIST_WEBGL2_SHADER_ARTIFACT.modules.glslEs300['vertex:lightListVertex']?.source;

    expect(postColorWgsl).toContain('fn generateFullscreenVertex');
    expect(postColorWgsl).toContain('fn fullscreenClipPosition');
    expect(skyboxWgsl).toContain('fn fullscreenClipPosition');
    expect(lightListWebGlVertex).toContain('fullscreenClipPosition');
  });

  it('light-list kernels share geometric intersection and memory layout constants', () => {
    const lightListWebGpu = LIGHT_LIST_SHADER_ARTIFACT.modules.wgsl;
    const lightListWebGlFragment =
      LIGHT_LIST_WEBGL2_SHADER_ARTIFACT.modules.glslEs300['fragment:lightListFragment']?.source;

    // Geometry intersection testing module
    expect(lightListWebGpu).toContain('fn distanceSquaredSphereToSphere');
    expect(lightListWebGpu).toContain('fn distanceSquaredSphereToAabb');
    expect(lightListWebGlFragment).toContain('distanceSquaredSphereToSphere');
    expect(lightListWebGlFragment).toContain('distanceSquaredSphereToAabb');

    // Memory layout constants module
    expect(lightListWebGpu).toContain('const LIGHT_HEADER_WORDS');
    expect(lightListWebGpu).toContain('const LIGHT_RECORD_WORDS');
    expect(lightListWebGlFragment).toContain('LIGHT_HEADER_WORDS');
    expect(lightListWebGlFragment).toContain('LIGHT_RECORD_WORDS');
  });

  it('shadow caster pass does not leak shadow receiver or IBL code', () => {
    const shadowWgsl = STANDARD_SHADOW_SHADER_ARTIFACT.modules.wgsl;

    // Shadow caster must NOT contain receiver visibility or IBL evaluation
    expect(shadowWgsl).not.toContain('directionalShadowVisibility');
    expect(shadowWgsl).not.toContain('DirectionalShadowData');
    expect(shadowWgsl).not.toContain('evaluateIbl');
    expect(shadowWgsl).not.toContain('EnvironmentData');
  });
});
