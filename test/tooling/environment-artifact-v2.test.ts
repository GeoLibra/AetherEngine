import { describe, expect, it } from 'vitest';
import {
  deserializeEnvironmentManifest,
  serializeEnvironmentManifest,
  validateEnvironmentArtifact,
  validateEnvironmentArtifactV1,
  validateEnvironmentArtifactV2
} from '../../tools/asset-cook/environment/artifact/manifest-codec';
import {
  cookEnvironmentPanorama,
  cookEnvironmentPanoramaV2,
  DEFAULT_COOK_RECIPES
} from '../../tools/asset-cook/environment/artifact/environment-cooker';
import type { CanonicalHdrPanorama } from '../../tools/asset-cook/environment/decode/types';

describe('EnvironmentArtifact@2 schema and serialization', () => {
  const dummyHdr: CanonicalHdrPanorama = {
    width: 16,
    height: 8,
    pixels: new Float32Array(16 * 8 * 3).fill(0.5),
    metadata: { format: '32-bit_rle_rgbe', rawHeaderBytes: 0 }
  };

  it('cooks and validates an EnvironmentArtifact@1 package', () => {
    const result = cookEnvironmentPanorama(dummyHdr, DEFAULT_COOK_RECIPES['smoke-v1']);
    expect(result.environmentArtifact.schema).toBe('EnvironmentArtifact@1');
    validateEnvironmentArtifact(result.environmentArtifact);
    validateEnvironmentArtifactV1(result.environmentArtifact);

    const json = serializeEnvironmentManifest(result.environmentArtifact);
    const roundtrip = deserializeEnvironmentManifest(json);
    expect(roundtrip.schema).toBe('EnvironmentArtifact@1');
  });

  it('cooks and validates an EnvironmentArtifact@2 package with panorama background', () => {
    const result = cookEnvironmentPanoramaV2(dummyHdr, DEFAULT_COOK_RECIPES['smoke-v1'], true);
    expect(result.environmentArtifact.schema).toBe('EnvironmentArtifact@2');
    expect(result.environmentArtifact.background.kind).toBe('panorama');
    expect(result.panoramaBlob).toBeDefined();
    expect(result.panoramaBlob!.byteLength).toBeGreaterThan(0);

    validateEnvironmentArtifact(result.environmentArtifact);
    validateEnvironmentArtifactV2(result.environmentArtifact);

    const json = serializeEnvironmentManifest(result.environmentArtifact);
    const roundtrip = deserializeEnvironmentManifest(json);
    expect(roundtrip.schema).toBe('EnvironmentArtifact@2');
    if (roundtrip.schema === 'EnvironmentArtifact@2') {
      expect(roundtrip.background.kind).toBe('panorama');
    }
  });

  it('cooks and validates an EnvironmentArtifact@2 package with absent background', () => {
    const result = cookEnvironmentPanoramaV2(dummyHdr, DEFAULT_COOK_RECIPES['smoke-v1'], false);
    expect(result.environmentArtifact.schema).toBe('EnvironmentArtifact@2');
    expect(result.environmentArtifact.background.kind).toBe('absent');
    expect(result.panoramaBlob).toBeUndefined();

    validateEnvironmentArtifact(result.environmentArtifact);
    validateEnvironmentArtifactV2(result.environmentArtifact);
  });

  it('rejects invalid schema or malformed background payload', () => {
    expect(() => validateEnvironmentArtifact({ schema: 'EnvironmentArtifact@3' } as any)).toThrow(
      /Invalid environment schema/
    );

    const validV2 = cookEnvironmentPanoramaV2(
      dummyHdr,
      DEFAULT_COOK_RECIPES['smoke-v1'],
      true
    ).environmentArtifact;
    const corruptedBg = {
      ...validV2,
      background: { kind: 'panorama', samplingAbi: 'unknown-abi' }
    };
    expect(() => validateEnvironmentArtifact(corruptedBg as any)).toThrow(
      /Invalid background sampling ABI/
    );
  });
});
