/**
 * @file Cross-pass silhouette and coverage conformance tests.
 * Asserts that shadow caster pass, lit pass, skybox, and post passes share identical
 * utility, surface, BRDF, and tone mapping modules from shared shader libraries.
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

describe('Cross-Pass Silhouette & Coverage Conformance', () => {
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

  it('shadow caster pass does not leak shadow receiver or IBL code', () => {
    const shadowWgsl = STANDARD_SHADOW_SHADER_ARTIFACT.modules.wgsl;

    // Shadow caster must NOT contain receiver visibility or IBL evaluation
    expect(shadowWgsl).not.toContain('directionalShadowVisibility');
    expect(shadowWgsl).not.toContain('DirectionalShadowData');
    expect(shadowWgsl).not.toContain('evaluateIbl');
    expect(shadowWgsl).not.toContain('EnvironmentData');
  });
});
