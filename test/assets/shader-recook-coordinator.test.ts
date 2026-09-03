import { describe, expect, test } from 'vitest';
import {
  CookArtifactPublisher,
  InMemoryCookArtifactStore,
  ShaderPackageAssetType,
  ShaderPackageHmrPublisher,
  ShaderRecookCoordinator,
  createAssetHandle,
  encodeCookedShaderArtifactPackage
} from '../../src';
import { STANDARD_LIT_SHADER_ABI_VERSION, STANDARD_LIT_SHADER_ARTIFACT } from '../../src/shader';

const PACKAGE_OPTIONS = Object.freeze({
  shaderAbiVersion: STANDARD_LIT_SHADER_ABI_VERSION,
  sourceLanguageVersion: 'wgsl-1',
  metadataSchemaVersion: 1,
  packageToolchain: Object.freeze({ id: 'aether-render-package', version: '1.0.0' })
});

describe('ShaderRecookCoordinator', () => {
  test('recooks affected shader nodes and publishes them only when the frame boundary commits', async () => {
    const bundle = await encodeCookedShaderArtifactPackage(
      STANDARD_LIT_SHADER_ARTIFACT,
      PACKAGE_OPTIONS
    );
    const calls: string[] = [];
    const store = new InMemoryCookArtifactStore();
    const mathPublisher = shaderPublisher('shader.math');
    const lightingPublisher = shaderPublisher('shader.lighting');
    const coordinator = new ShaderRecookCoordinator({
      artifactPublisher: new CookArtifactPublisher(store),
      cooker: {
        async cook(nodeId) {
          calls.push(nodeId);
          return {
            bundle,
            dependencies: nodeId === 'shader://lighting' ? ['shader://math'] : [],
            inputHashes: [`source:${nodeId}`],
            toolchainVersion: 'naga-27'
          };
        }
      }
    });
    coordinator.register({ nodeId: 'shader://math', dependencies: [], publisher: mathPublisher });
    coordinator.register({
      nodeId: 'shader://lighting',
      dependencies: ['shader://math'],
      publisher: lightingPublisher
    });

    const results = await coordinator.sourceChanged('shader://math');

    expect(calls).toEqual(['shader://math', 'shader://lighting']);
    expect(results.map(({ nodeId, status }) => ({ nodeId, status }))).toEqual([
      { nodeId: 'shader://math', status: 'staged' },
      { nodeId: 'shader://lighting', status: 'staged' }
    ]);
    expect(mathPublisher.resolve()).toEqual({ kind: 'unavailable' });
    expect(lightingPublisher.resolve()).toEqual({ kind: 'unavailable' });
    expect(store.published('shader://lighting')?.outputs.map(({ name }) => name)).toEqual([
      'manifest',
      ...[...bundle.blobs.keys()].sort().map((id) => `blob:${id}`)
    ]);

    expect(coordinator.commitFrame().map(({ status }) => status)).toEqual([
      'published',
      'published'
    ]);
    expect(mathPublisher.resolve()).toMatchObject({ kind: 'available', payload: { version: 1 } });
    expect(lightingPublisher.resolve()).toMatchObject({
      kind: 'available',
      payload: { version: 1 }
    });
  });

  test('suppresses an obsolete cook completion after a newer source revision is requested', async () => {
    const first = deferred<Awaited<ReturnType<typeof encodeCookedShaderArtifactPackage>>>();
    const second = deferred<Awaited<ReturnType<typeof encodeCookedShaderArtifactPackage>>>();
    let call = 0;
    const publisher = shaderPublisher('shader.standard-lit');
    const coordinator = new ShaderRecookCoordinator({
      artifactPublisher: new CookArtifactPublisher(new InMemoryCookArtifactStore()),
      cooker: {
        async cook() {
          call += 1;
          return {
            bundle: await (call === 1 ? first.promise : second.promise),
            dependencies: [],
            inputHashes: [`source-${call}`],
            toolchainVersion: 'naga-27'
          };
        }
      }
    });
    coordinator.register({ nodeId: 'shader://standard-lit', dependencies: [], publisher });

    const older = coordinator.sourceChanged('shader://standard-lit');
    const newer = coordinator.sourceChanged('shader://standard-lit');
    second.resolve(
      await encodeCookedShaderArtifactPackage(STANDARD_LIT_SHADER_ARTIFACT, PACKAGE_OPTIONS)
    );
    await expect(newer).resolves.toMatchObject([{ status: 'staged', revision: 2 }]);
    first.resolve(
      await encodeCookedShaderArtifactPackage(STANDARD_LIT_SHADER_ARTIFACT, PACKAGE_OPTIONS)
    );

    await expect(older).resolves.toEqual([
      { nodeId: 'shader://standard-lit', revision: 1, status: 'stale' }
    ]);
    expect(coordinator.commitFrame()).toMatchObject([{ status: 'published', revision: 2 }]);
  });
});

function shaderPublisher(id: string): ShaderPackageHmrPublisher {
  return new ShaderPackageHmrPublisher(createAssetHandle(ShaderPackageAssetType, id));
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
