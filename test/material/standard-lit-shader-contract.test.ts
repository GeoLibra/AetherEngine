import { describe, expect, test } from 'vitest';
import {
  STANDARD_LIT_SHADER_ABI_VERSION,
  STANDARD_LIT_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
  createCookedShaderBindingManifest
} from '../../src';

describe('StandardLit WGSL single-source-of-truth shader contract', () => {
  describe('canonical shader binding layout reflection', () => {
    test('reflects group 2 material uniform, 5 texture roles, and surface sampler', () => {
      const manifest = createCookedShaderBindingManifest(
        STANDARD_LIT_SHADER_ARTIFACT,
        STANDARD_LIT_SHADER_ABI_VERSION
      );
      const materialGroup = manifest.groups.find(({ group }) => group === 2);
      expect(materialGroup).toBeDefined();

      const entries = materialGroup!.entries.map(({ binding, kind, name }) => ({
        binding,
        kind,
        name
      }));

      expect(entries).toEqual([
        { binding: 0, kind: 'uniform-buffer', name: 'materialData' },
        { binding: 1, kind: 'texture', name: 'baseColorTexture' },
        { binding: 2, kind: 'texture', name: 'metallicRoughnessTexture' },
        { binding: 3, kind: 'texture', name: 'normalTexture' },
        { binding: 4, kind: 'texture', name: 'occlusionTexture' },
        { binding: 5, kind: 'texture', name: 'emissiveTexture' },
        { binding: 6, kind: 'sampler', name: 'surfaceSampler' }
      ]);
    });

    test('reflects materialData buffer layout matching glTF PBR standard factors and UV transforms', () => {
      const manifest = createCookedShaderBindingManifest(
        STANDARD_LIT_SHADER_ARTIFACT,
        STANDARD_LIT_SHADER_ABI_VERSION
      );
      const materialBuffer = manifest.buffers.find(({ name }) => name === 'materialData');
      expect(materialBuffer).toBeDefined();

      const fieldNames = materialBuffer!.fields.map((f) => f.path);
      // Ensure NO artificial padding fields pollute the reflected layout
      expect(fieldNames.filter((name) => name.startsWith('pad'))).toEqual([]);

      expect(fieldNames).toEqual([
        'baseColor',
        'emissiveFactor',
        'normalScale',
        'metallic',
        'roughness',
        'occlusionStrength',
        'alphaCutoff',
        'baseColorUvSet',
        'metallicRoughnessUvSet',
        'normalUvSet',
        'occlusionUvSet',
        'emissiveUvSet',
        'alphaMask',
        'baseColorTransform',
        'baseColorOffset',
        'metallicRoughnessTransform',
        'metallicRoughnessOffset',
        'normalTransform',
        'normalOffset',
        'occlusionTransform',
        'occlusionOffset',
        'emissiveTransform',
        'emissiveOffset'
      ]);
    });

    test('validates natural WGSL layout ABI golden: exact byte offsets and 240-byte total size', () => {
      const layout = STANDARD_LIT_SHADER_ARTIFACT.bufferLayouts.find(
        (b) => b.name === 'materialData'
      );
      expect(layout).toBeDefined();
      expect(layout!.byteSize).toBe(240);

      const offsetMap = Object.fromEntries(layout!.fields.map((f) => [f.path, f.offset]));
      expect(offsetMap).toEqual({
        baseColor: 0,
        emissiveFactor: 16,
        normalScale: 28,
        metallic: 32,
        roughness: 36,
        occlusionStrength: 40,
        alphaCutoff: 44,
        baseColorUvSet: 48,
        metallicRoughnessUvSet: 52,
        normalUvSet: 56,
        occlusionUvSet: 60,
        emissiveUvSet: 64,
        alphaMask: 68,
        baseColorTransform: 80,
        baseColorOffset: 96,
        metallicRoughnessTransform: 112,
        metallicRoughnessOffset: 128,
        normalTransform: 144,
        normalOffset: 160,
        occlusionTransform: 176,
        occlusionOffset: 192,
        emissiveTransform: 208,
        emissiveOffset: 224
      });
    });

    test('cross-backend portable ABI parity: WebGPU WGSL and WebGL2 buffer layouts are identical', () => {
      const webgpuLayout = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.bufferLayouts.find(
        (b) => b.name === 'materialData'
      );
      const webgl2Layout = STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.bufferLayouts.find(
        (b) => b.name === 'materialData'
      );
      expect(webgpuLayout).toBeDefined();
      expect(webgl2Layout).toBeDefined();

      expect(webgpuLayout!.byteSize).toBe(240);
      expect(webgl2Layout!.byteSize).toBe(240);

      const webgpuOffsets = webgpuLayout!.fields.map((f) => ({ path: f.path, offset: f.offset }));
      const webgl2Offsets = webgl2Layout!.fields.map((f) => ({ path: f.path, offset: f.offset }));
      expect(webgpuOffsets).toEqual(webgl2Offsets);
    });
  });

  describe('WGSL authoritative channel semantics and numerical rules', () => {
    test('standard-lit WGSL defines glTF channel composition and coverage discard in shader source', () => {
      const wgsl = STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl;

      // Base color composition: factor * textureSample * vertexColor via shared surface module
      expect(wgsl).toContain('materialData.baseColor * baseSample * input.color');

      // Metallic: sampled from B channel of metallicRoughness texture
      expect(wgsl).toContain('materialData.metallic * mrSample.b');

      // Roughness: sampled from G channel of metallicRoughness texture
      expect(wgsl).toContain('materialData.roughness * mrSample.g');

      // Normal: unpacked from [0, 1] to [-1, 1] and scaled by normalScale
      expect(wgsl).toContain(
        'textureSample(normalTexture, surfaceSampler, normUv).xyz * 2.0 - vec3<f32>(1.0)'
      );
      expect(wgsl).toContain('normalSample.xy * materialData.normalScale');

      // Occlusion: 1.0 + occlusionStrength * (aoSample - 1.0) using R channel
      expect(wgsl).toContain('1.0 + materialData.occlusionStrength * (aoSample - 1.0)');

      // Emissive: factor * textureSample
      expect(wgsl).toContain('materialData.emissiveFactor * emissiveSample');

      // Clamping: metallic in [0, 1], roughness clamped to minimum 0.045 to avoid singularity
      expect(wgsl).toContain('clamp(metallic, 0.0, 1.0)');
      expect(wgsl).toContain('clamp(roughness, 0.045, 1.0)');

      // Alpha coverage: conditional discard in mask mode based on alphaCutoff via shared coverage module
      expect(wgsl).toContain(
        'if (!evaluateAlphaCoverage(surface.baseColor.a, materialData.alphaCutoff, materialData.alphaMask)) {\n    discard;\n  }'
      );
      expect(wgsl).toContain('fn evaluateAlphaCoverage');
    });

    test('standard-lit-list WGSL defines consistent StandardLitSurface sampling struct and clamps', () => {
      const wgsl = STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT.modules.wgsl;

      // StandardLitSurface structure definition
      expect(wgsl).toContain('struct StandardLitSurface');
      expect(wgsl).toContain('fn sampleStandardLitSurface');

      // Channel mapping & clamping into StandardLitSurface
      expect(wgsl).toContain('clamp(materialData.metallic * mrSample.b, 0.0, 1.0)');
      expect(wgsl).toContain('clamp(materialData.roughness * mrSample.g, 0.045, 1.0)');
      expect(wgsl).toContain('1.0 + materialData.occlusionStrength * (aoSample - 1.0)');
      expect(wgsl).toContain('materialData.baseColor * baseSample * input.color');
      expect(wgsl).toContain('materialData.emissiveFactor * emissiveSample');
    });
  });

  describe('backend lowering parity (WebGL2 GLSL ES 3.00)', () => {
    test('transpiled GLSL ES 3.00 preserves identical channel mapping and numerical clamping', () => {
      const glslModule =
        STANDARD_LIT_SHADER_ARTIFACT.modules.glslEs300['fragment:standardLitFragment'];
      expect(glslModule).toBeDefined();
      const glsl = glslModule!.source;

      // GLSL contains clamp operations for metallic and roughness
      expect(glsl).toMatch(/clamp\([^,]+,\s*0\.0,\s*1\.0\)/);
      expect(glsl).toMatch(/clamp\([^,]+,\s*0\.045,\s*1\.0\)/);

      // GLSL contains discard for alpha mask coverage
      expect(glsl).toContain('discard;');

      // GLSL accesses normal unpacking and metallic-roughness channels
      expect(glsl).toContain('2.0');
    });

    test('standard-lit-list WebGL2 artifact preserves identical surface construction', () => {
      const glslModule =
        STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT.modules.glslEs300['fragment:standardLitFragment'];
      expect(glslModule).toBeDefined();
      const glsl = glslModule!.source;

      expect(glsl).toContain('StandardLitSurface');
      expect(glsl).toMatch(/0\.045/);
    });
  });
});
