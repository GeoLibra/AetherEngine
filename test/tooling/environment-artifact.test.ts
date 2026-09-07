import { describe, expect, it } from 'vitest';
import {
  cookBrdfLut,
  cookEnvironmentPanorama,
  DEFAULT_COOK_RECIPES,
  deserializeBrdfLutManifest,
  deserializeEnvironmentManifest,
  float16ToFloat32,
  float32ToFloat16,
  packRgbToRgba16Float,
  serializeBrdfLutManifest,
  serializeEnvironmentManifest,
  unpackRgba16Float
} from '../../tools/asset-cook/environment';
import { createConstantHdrFixture } from '../../benchmark/environment-cook/fixtures';

describe('Environment artifact packaging and binary packing', () => {
  it('converts between Float32 and Float16 with expected precision', () => {
    expect(float16ToFloat32(float32ToFloat16(0))).toBe(0);
    expect(float16ToFloat32(float32ToFloat16(1.0))).toBeCloseTo(1.0, 3);
    expect(float16ToFloat32(float32ToFloat16(65504.0))).toBeCloseTo(65504.0, -1);
    expect(() => float32ToFloat16(65505.0)).toThrow(/overflow/i);
  });

  it('packs and unpacks RGBA16F buffers preserving values', () => {
    const rgb = new Float32Array([1.0, 2.0, 3.0, 0.5, 0.25, 0.125]);
    const packed = packRgbToRgba16Float(rgb, 2, 1);
    expect(packed.byteLength).toBe(2 * 1 * 8);

    const unpacked = unpackRgba16Float(packed, 2, 1);
    expect(unpacked[0]).toBeCloseTo(1.0, 2);
    expect(unpacked[1]).toBeCloseTo(2.0, 2);
    expect(unpacked[2]).toBeCloseTo(3.0, 2);
    expect(unpacked[3]).toBeCloseTo(1.0, 2); // alpha = 1.0
    expect(unpacked[4]).toBeCloseTo(0.5, 2);
    expect(unpacked[5]).toBeCloseTo(0.25, 2);
    expect(unpacked[6]).toBeCloseTo(0.125, 2);
    expect(unpacked[7]).toBeCloseTo(1.0, 2);
  });

  it('cooks shared BRDF LUT with valid schema and binary payload', () => {
    const { artifact, blob } = cookBrdfLut(16, 64);
    expect(artifact.schema).toBe('BrdfLutArtifact@1');
    expect(artifact.samplingAbi).toBe('ibl-equirect-ggx@1');
    expect(blob.byteLength).toBe(16 * 16 * 8);
    expect(artifact.payload.byteLength).toBe(blob.byteLength);

    const json = serializeBrdfLutManifest(artifact);
    const roundtrip = deserializeBrdfLutManifest(json);
    expect(roundtrip.schema).toBe(artifact.schema);
    expect(roundtrip.payload.blobHash).toBe(artifact.payload.blobHash);
  });

  it('cooks full environment panorama with valid mips and manifest', () => {
    const fixture = createConstantHdrFixture(32, 16, [1.0, 1.0, 1.0]);
    const canonicalSource = {
      width: fixture.width,
      height: fixture.height,
      pixels: fixture.data,
      metadata: { format: '32-bit_rle_rgbe', rawHeaderBytes: 100 }
    };

    const result = cookEnvironmentPanorama(canonicalSource, DEFAULT_COOK_RECIPES['smoke-v1']);
    const { environmentArtifact, irradianceBlob, radianceBlob } = result;

    expect(environmentArtifact.schema).toBe('EnvironmentArtifact@1');
    expect(environmentArtifact.samplingAbi).toBe('ibl-equirect-ggx@1');
    expect(environmentArtifact.maxValidRadianceLod).toBeGreaterThanOrEqual(1);

    // Check irradiance payload
    expect(irradianceBlob.byteLength).toBe(16 * 8 * 8);
    expect(environmentArtifact.irradiance.byteLength).toBe(irradianceBlob.byteLength);

    // Check radiance mips are contiguous
    const levels = environmentArtifact.radiance.levels;
    expect(levels.length).toBe(environmentArtifact.maxValidRadianceLod + 1);
    let expectedOffset = 0;
    for (const lvl of levels) {
      expect(lvl.byteOffset).toBe(expectedOffset);
      expect(lvl.byteLength).toBe(lvl.width * lvl.height * 8);
      expectedOffset += lvl.byteLength;
    }
    expect(radianceBlob.byteLength).toBe(expectedOffset);

    // Manifest roundtrip
    const json = serializeEnvironmentManifest(environmentArtifact);
    const roundtrip = deserializeEnvironmentManifest(json);
    expect(roundtrip.recipeHash).toBe(environmentArtifact.recipeHash);
    expect(roundtrip.radiance.levels.length).toBe(levels.length);
  });
});
