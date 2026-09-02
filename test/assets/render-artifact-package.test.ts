import { describe, expect, test } from 'vitest';
import {
  decodeRenderArtifactPackage,
  encodeRenderArtifactPackage,
  type RenderArtifactPackageInput
} from '../../src/assets';

const REQUIRED_SECTIONS = [
  'manifest',
  'material-schema',
  'techniques',
  'variant-table',
  'reflection',
  'layout-plans',
  'shader-module',
  'dependencies'
] as const;

function packageInput(): RenderArtifactPackageInput {
  return {
    artifactKind: 'material',
    shaderAbiVersion: 2,
    materialSchemaVersion: 1,
    toolchain: { id: 'aether-render-cooker', version: '1.0.0' },
    shaderToolchain: {
      cookerId: 'aether-native-wgsl-cooker',
      cookerVersion: '0.0.0',
      sourceKind: 'wgsl',
      sourceLanguageVersion: 'wgsl-1',
      nagaVersion: '30.0.0',
      metadataSchemaVersion: 1
    },
    sections: REQUIRED_SECTIONS.map((kind, index) => ({
      id: `${kind}-v1`,
      kind,
      required: true,
      payload: { index, kind }
    }))
  };
}

describe('Render Artifact Package canonical JSON reference codec', () => {
  test('round-trips deterministic external blobs with independent integrity identities', async () => {
    const first = await encodeRenderArtifactPackage(packageInput());
    const second = await encodeRenderArtifactPackage({
      ...packageInput(),
      sections: [...packageInput().sections].reverse()
    });

    expect(second.manifest).toBe(first.manifest);
    expect([...second.blobs]).toEqual([...first.blobs]);
    const raw = JSON.parse(first.manifest) as {
      envelope: {
        sections: Array<{ location: { storage: string; blobId: string }; offset?: number }>;
      };
    };
    expect(raw.envelope.sections.every(({ location }) => location.storage === 'external')).toBe(
      true
    );
    expect(raw.envelope.sections.every((section) => section.offset === undefined)).toBe(true);
    const decoded = await decodeRenderArtifactPackage(first);
    expect(decoded.envelope.magic).toBe('AERENDER');
    expect(decoded.envelope.packageId).toBe(`render:${decoded.envelope.semanticContentHash}`);
    expect(decoded.envelope.containerHash).toMatch(/^[a-f0-9]{64}$/);
    expect(decoded.sections.map(({ kind }) => kind)).toEqual([...REQUIRED_SECTIONS].sort());
  });

  test('rejects a modified external blob before publishing payloads', async () => {
    const bundle = await encodeRenderArtifactPackage(packageInput());
    const blobs = new Map(bundle.blobs);
    const firstBlobId = blobs.keys().next().value as string;
    blobs.set(firstBlobId, new TextEncoder().encode('{"corrupted":true}'));

    await expect(decodeRenderArtifactPackage({ manifest: bundle.manifest, blobs })).rejects.toThrow(
      /container-integrity-failed/
    );
  });

  test('rejects a missing external blob before decoding sections', async () => {
    const bundle = await encodeRenderArtifactPackage(packageInput());
    const blobs = new Map(bundle.blobs);
    const firstBlobId = blobs.keys().next().value as string;
    blobs.delete(firstBlobId);

    await expect(decodeRenderArtifactPackage({ manifest: bundle.manifest, blobs })).rejects.toThrow(
      /external-blob-missing/
    );
  });

  test('rejects unsupported versions and missing production sections', async () => {
    await expect(
      encodeRenderArtifactPackage({ ...packageInput(), containerVersion: 2 })
    ).rejects.toThrow(/container-version-unsupported/);
    await expect(
      encodeRenderArtifactPackage({
        ...packageInput(),
        sections: packageInput().sections.filter(({ kind }) => kind !== 'reflection')
      })
    ).rejects.toThrow(/required-section-missing.*reflection/);
  });

  test('allows a shader-library without material-only sections', async () => {
    const input = packageInput();
    const bundle = await encodeRenderArtifactPackage({
      artifactKind: 'shader-library',
      containerVersion: input.containerVersion,
      shaderAbiVersion: input.shaderAbiVersion,
      toolchain: input.toolchain,
      shaderToolchain: input.shaderToolchain,
      sections: input.sections.filter(
        ({ kind }) =>
          kind !== 'material-schema' && kind !== 'techniques' && kind !== 'variant-table'
      )
    });

    const decoded = await decodeRenderArtifactPackage(bundle);
    expect(decoded.envelope.artifactKind).toBe('shader-library');
  });

  test('keeps material-only sections required for material packages', async () => {
    const input = packageInput();
    await expect(
      encodeRenderArtifactPackage({
        ...input,
        sections: input.sections.filter(({ kind }) => kind !== 'techniques')
      })
    ).rejects.toThrow(/required-section-missing.*techniques/);
  });

  test('requires Naga provenance for WGSL packages', async () => {
    const input = packageInput();
    await expect(
      encodeRenderArtifactPackage({
        ...input,
        shaderToolchain: { ...input.shaderToolchain, nagaVersion: undefined }
      })
    ).rejects.toThrow(/shader-toolchain-invalid.*nagaVersion/);
  });

  test('includes package profile and ABI metadata in semantic identity', async () => {
    const first = await decodeRenderArtifactPackage(
      await encodeRenderArtifactPackage(packageInput())
    );
    const second = await decodeRenderArtifactPackage(
      await encodeRenderArtifactPackage({ ...packageInput(), shaderAbiVersion: 3 })
    );

    expect(second.envelope.semanticContentHash).not.toBe(first.envelope.semanticContentHash);
    expect(second.envelope.packageId).not.toBe(first.envelope.packageId);
  });
});
