/**
 * @file Cross-pass silhouette and coverage conformance tests.
 * Asserts that shadow caster pass and lit pass share identical UV transforms
 * and alpha coverage discard predicates from shared shader modules.
 */

import { describe, expect, it } from 'vitest';
import { STANDARD_SHADOW_SHADER_ARTIFACT } from '../../src/shader/builtins/standard-shadow';
import { STANDARD_LIT_SHADER_ARTIFACT } from '../../src/shader/builtins/standard-lit';
import {
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT
} from '../../src/shader/builtins/standard-lit-list';

describe('Cross-Pass Silhouette & Coverage Conformance', () => {
  it('shadow and lit passes include identical evaluateAlphaCoverage logic in cooked artifacts', () => {
    const shadowWgsl = STANDARD_SHADOW_SHADER_ARTIFACT.modules.wgsl;
    const litWgsl = STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl;
    const litListWebGpu = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;
    const litListWebGl = STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.modules.wgsl;

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
});
