import { describe, expect, test } from 'vitest';
import {
  decodeCookedShaderArtifactPackage,
  decodeRenderArtifactPackage,
  encodeCookedShaderArtifactPackage,
  encodeRenderArtifactPackage,
  type DecodedRenderArtifactPackage,
  type RenderArtifactPackageSectionInput
} from '../../src';
import { STANDARD_LIT_SHADER_ABI_VERSION, STANDARD_LIT_SHADER_ARTIFACT } from '../../src/shader';

const PACKAGE_OPTIONS = Object.freeze({
  shaderAbiVersion: STANDARD_LIT_SHADER_ABI_VERSION,
  sourceLanguageVersion: 'wgsl-1',
  metadataSchemaVersion: 1,
  packageToolchain: Object.freeze({ id: 'aether-render-package', version: '1.0.0' })
});

describe('cooked shader Render Artifact package bridge', () => {
  test('round-trips the committed standard-lit artifact through separated sections', async () => {
    const bundle = await encodeCookedShaderArtifactPackage(
      STANDARD_LIT_SHADER_ARTIFACT,
      PACKAGE_OPTIONS
    );
    const decodedPackage = await decodeRenderArtifactPackage(bundle);

    expect(decodedPackage.envelope.artifactKind).toBe('shader-library');
    expect(decodedPackage.envelope.materialSchemaVersion).toBeUndefined();
    expect(decodedPackage.sections.filter(({ kind }) => kind === 'shader-module').length).toBe(3);
    expect(
      decodedPackage.sections.find(({ id }) => id === 'module:glsl300es:vertex:standardLitVertex')
        ?.target
    ).toEqual({
      shaderTarget: 'glsl300es',
      stage: 'vertex',
      entryPoint: 'standardLitVertex'
    });
    await expect(decodeCookedShaderArtifactPackage(bundle)).resolves.toEqual(
      STANDARD_LIT_SHADER_ARTIFACT
    );
  });

  test('rejects a valid package whose target module closure is incomplete', async () => {
    const decoded = await createDecodedPackage();
    const incomplete = decoded.sections.filter(
      ({ id }) => id !== 'module:glsl300es:fragment:standardLitFragment'
    );
    const bundle = await repackage(decoded, incomplete);

    await expect(decodeCookedShaderArtifactPackage(bundle)).rejects.toThrow(
      /artifact-module-missing/
    );
  });

  test('rejects duplicate semantic target modules even when section IDs are unique', async () => {
    const decoded = await createDecodedPackage();
    const module = decoded.sections.find(
      ({ id }) => id === 'module:glsl300es:vertex:standardLitVertex'
    )!;
    const bundle = await repackage(decoded, [
      ...decoded.sections,
      { ...module, id: `${module.id}:duplicate` }
    ]);

    await expect(decodeCookedShaderArtifactPackage(bundle)).rejects.toThrow(
      /shader-package-module-duplicate/
    );
  });
});

async function createDecodedPackage(): Promise<DecodedRenderArtifactPackage> {
  return decodeRenderArtifactPackage(
    await encodeCookedShaderArtifactPackage(STANDARD_LIT_SHADER_ARTIFACT, PACKAGE_OPTIONS)
  );
}

async function repackage(
  decoded: DecodedRenderArtifactPackage,
  sections: readonly Readonly<RenderArtifactPackageSectionInput>[]
) {
  return encodeRenderArtifactPackage({
    artifactKind: 'shader-library',
    shaderAbiVersion: decoded.envelope.shaderAbiVersion,
    toolchain: decoded.envelope.toolchain,
    shaderToolchain: decoded.envelope.shaderToolchain,
    sections
  });
}
