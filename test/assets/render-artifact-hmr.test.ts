import { describe, expect, test } from 'vitest';
import {
  ShaderPackageAssetType,
  ShaderPackageHmrPublisher,
  createAssetHandle,
  decodeCookedShaderPackage,
  encodeCookedShaderArtifactPackage
} from '../../src';
import { STANDARD_LIT_SHADER_ABI_VERSION, STANDARD_LIT_SHADER_ARTIFACT } from '../../src/shader';

const PACKAGE_OPTIONS = Object.freeze({
  shaderAbiVersion: STANDARD_LIT_SHADER_ABI_VERSION,
  sourceLanguageVersion: 'wgsl-1',
  metadataSchemaVersion: 1,
  packageToolchain: Object.freeze({ id: 'aether-render-package', version: '1.0.0' })
});

describe('ShaderPackageHmrPublisher', () => {
  test('stages a complete package and publishes it only at the explicit frame boundary', async () => {
    const handle = createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit');
    const publisher = new ShaderPackageHmrPublisher(handle);
    const bundle = await encodeCookedShaderArtifactPackage(
      STANDARD_LIT_SHADER_ARTIFACT,
      PACKAGE_OPTIONS
    );

    const staged = await publisher.stage({ revision: 1, bundle });

    expect(staged).toMatchObject({ status: 'staged', revision: 1, changedKind: 'initial' });
    expect(publisher.resolve()).toEqual({ kind: 'unavailable' });
    expect(publisher.handle).toBe(handle);

    const committed = publisher.commit(1);

    expect(committed).toMatchObject({
      status: 'published',
      revision: 1,
      oldVersion: undefined,
      newVersion: 1,
      changedKind: 'initial',
      listenerDiagnostics: []
    });
    const resolved = publisher.resolve();
    expect(resolved.kind).toBe('available');
    if (resolved.kind !== 'available') throw new Error('Expected a published shader package.');
    expect(resolved.payload.version).toBe(1);
    expect(resolved.payload.value.artifact).toEqual(STANDARD_LIT_SHADER_ARTIFACT);
    if (staged.status !== 'staged') throw new Error('Expected a staged shader package.');
    expect(resolved.payload.value.packageId).toBe(staged.packageId);
    expect(resolved.payload.value.handle).toBe(handle);
  });

  test('classifies an update with stable reflection and layout identities as module-only', async () => {
    const publisher = new ShaderPackageHmrPublisher(
      createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit')
    );
    await publisher.stage({ revision: 1, bundle: await standardLitBundle() });
    publisher.commit(1);
    const moduleOnlyArtifact = {
      ...STANDARD_LIT_SHADER_ARTIFACT,
      modules: {
        ...STANDARD_LIT_SHADER_ARTIFACT.modules,
        wgsl: `${STANDARD_LIT_SHADER_ARTIFACT.modules.wgsl}\n// hmr module revision`
      }
    };

    const staged = await publisher.stage({
      revision: 2,
      bundle: await encodeCookedShaderArtifactPackage(moduleOnlyArtifact, PACKAGE_OPTIONS)
    });

    expect(staged).toMatchObject({ status: 'staged', revision: 2, changedKind: 'module-only' });
    expect(publisher.commit(2)).toMatchObject({
      status: 'published',
      oldVersion: 1,
      newVersion: 2,
      changedKind: 'module-only'
    });
  });

  test('retains the last-good package when a candidate fails validation', async () => {
    const publisher = new ShaderPackageHmrPublisher(
      createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit')
    );
    await publisher.stage({ revision: 1, bundle: await standardLitBundle() });
    publisher.commit(1);
    const validBundle = await standardLitBundle();
    const corruptedBlobs = new Map(validBundle.blobs);
    const firstBlobId = corruptedBlobs.keys().next().value;
    if (!firstBlobId) throw new Error('Expected the shader package to contain at least one blob.');
    corruptedBlobs.set(firstBlobId, new TextEncoder().encode('corrupted shader package blob'));

    const failed = await publisher.stage({
      revision: 2,
      bundle: { manifest: validBundle.manifest, blobs: corruptedBlobs }
    });

    expect(failed).toMatchObject({
      status: 'failed',
      revision: 2,
      diagnostic: { code: 'shader-package-validation-failed' }
    });
    expect(publisher.snapshot()).toMatchObject({
      kind: 'failed',
      revision: 2,
      lastGoodVersion: 1,
      diagnostic: { code: 'shader-package-validation-failed' }
    });
    const resolved = publisher.resolve();
    expect(resolved.kind).toBe('available');
    if (resolved.kind !== 'available') throw new Error('Expected the last-good shader package.');
    expect(resolved.payload.version).toBe(1);
    expect(publisher.commit(2)).toEqual({ status: 'not-staged', revision: 2 });
  });

  test('suppresses an older async decode result after a newer revision is requested', async () => {
    const revisionTwo = deferred<Awaited<ReturnType<typeof decodeCookedShaderPackage>>>();
    const revisionThree = deferred<Awaited<ReturnType<typeof decodeCookedShaderPackage>>>();
    const bundleTwo = await standardLitBundle();
    const bundleThree = await standardLitBundle();
    const publisher = new ShaderPackageHmrPublisher(
      createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit'),
      {
        decoder: {
          decode(bundle) {
            if (bundle === bundleTwo) return revisionTwo.promise;
            if (bundle === bundleThree) return revisionThree.promise;
            throw new Error('Unexpected shader package bundle.');
          }
        }
      }
    );
    const stageTwo = publisher.stage({ revision: 2, bundle: bundleTwo });
    const stageThree = publisher.stage({ revision: 3, bundle: bundleThree });

    revisionThree.resolve(await decodeCookedShaderPackage(bundleThree));
    await expect(stageThree).resolves.toMatchObject({ status: 'staged', revision: 3 });
    revisionTwo.resolve(await decodeCookedShaderPackage(bundleTwo));
    await expect(stageTwo).resolves.toEqual({ status: 'stale', revision: 2 });

    expect(publisher.commit(2)).toEqual({ status: 'not-staged', revision: 2 });
    expect(publisher.commit(3)).toMatchObject({ status: 'published', revision: 3, newVersion: 1 });
  });

  test('invalidates an older staged candidate as soon as a newer revision is requested', async () => {
    const newerDecode = deferred<Awaited<ReturnType<typeof decodeCookedShaderPackage>>>();
    const bundleOne = await standardLitBundle();
    const bundleTwo = await standardLitBundle();
    const publisher = new ShaderPackageHmrPublisher(
      createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit'),
      {
        decoder: {
          decode(bundle) {
            return bundle === bundleTwo ? newerDecode.promise : decodeCookedShaderPackage(bundle);
          }
        }
      }
    );
    await publisher.stage({ revision: 1, bundle: bundleOne });

    const stageTwo = publisher.stage({ revision: 2, bundle: bundleTwo });

    expect(publisher.snapshot()).toEqual({
      kind: 'staging',
      revision: 2,
      lastGoodVersion: undefined
    });
    expect(publisher.commit(1)).toEqual({ status: 'not-staged', revision: 1 });
    newerDecode.resolve(await decodeCookedShaderPackage(bundleTwo));
    await expect(stageTwo).resolves.toMatchObject({ status: 'staged', revision: 2 });
  });

  test('retains last-good when a layout ABI change has no compatibility preparer', async () => {
    const publisher = new ShaderPackageHmrPublisher(
      createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit')
    );
    await publisher.stage({ revision: 1, bundle: await standardLitBundle() });
    publisher.commit(1);

    const result = await publisher.stage({
      revision: 2,
      bundle: await encodeCookedShaderArtifactPackage(STANDARD_LIT_SHADER_ARTIFACT, {
        ...PACKAGE_OPTIONS,
        shaderAbiVersion: PACKAGE_OPTIONS.shaderAbiVersion + 1
      })
    });

    expect(result).toMatchObject({
      status: 'failed',
      revision: 2,
      diagnostic: { code: 'shader-package-layout-rebase-required' }
    });
    expect(publisher.resolve()).toMatchObject({ kind: 'available', payload: { version: 1 } });
    expect(publisher.commit(2)).toEqual({ status: 'not-staged', revision: 2 });
  });

  test('publishes a layout ABI change only after compatibility preparation succeeds', async () => {
    const publisher = new ShaderPackageHmrPublisher(
      createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit'),
      { compatibilityPreparer: { prepare: async () => ({ ok: true }) } }
    );
    await publisher.stage({ revision: 1, bundle: await standardLitBundle() });
    publisher.commit(1);

    const staged = await publisher.stage({ revision: 2, bundle: await layoutChangedBundle() });

    expect(staged).toMatchObject({ status: 'staged', revision: 2, changedKind: 'layout-abi' });
    expect(publisher.commit(2)).toMatchObject({
      status: 'published',
      oldVersion: 1,
      newVersion: 2,
      changedKind: 'layout-abi'
    });
  });

  test('retains last-good when compatibility preparation rejects a layout ABI change', async () => {
    const publisher = new ShaderPackageHmrPublisher(
      createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit'),
      {
        compatibilityPreparer: {
          prepare: async () => ({ ok: false, message: 'Material bindings cannot be rebased.' })
        }
      }
    );
    await publisher.stage({ revision: 1, bundle: await standardLitBundle() });
    publisher.commit(1);

    const result = await publisher.stage({ revision: 2, bundle: await layoutChangedBundle() });

    expect(result).toMatchObject({
      status: 'failed',
      diagnostic: {
        code: 'shader-package-layout-rebase-failed',
        message: 'Material bindings cannot be rebased.'
      }
    });
    expect(publisher.resolve()).toMatchObject({ kind: 'available', payload: { version: 1 } });
  });

  test('suppresses a layout preparation result when a newer revision finishes first', async () => {
    const preparation = deferred<{ ok: true }>();
    const preparationStarted = deferred<void>();
    const publisher = new ShaderPackageHmrPublisher(
      createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit'),
      {
        compatibilityPreparer: {
          prepare: () => {
            preparationStarted.resolve();
            return preparation.promise;
          }
        }
      }
    );
    await publisher.stage({ revision: 1, bundle: await standardLitBundle() });
    publisher.commit(1);

    const stageTwo = publisher.stage({ revision: 2, bundle: await layoutChangedBundle() });
    await preparationStarted.promise;
    const stageThree = publisher.stage({ revision: 3, bundle: await standardLitBundle() });
    await expect(stageThree).resolves.toMatchObject({ status: 'staged', revision: 3 });
    preparation.resolve({ ok: true });

    await expect(stageTwo).resolves.toEqual({ status: 'stale', revision: 2 });
    expect(publisher.commit(3)).toMatchObject({ status: 'published', revision: 3, newVersion: 2 });
  });

  test('publishes a dependency change before notifying subscribers exactly once', async () => {
    const publisher = new ShaderPackageHmrPublisher(
      createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit')
    );
    await publisher.stage({ revision: 1, bundle: await standardLitBundle() });
    publisher.commit(1);
    const observed: Array<{ version: number; changedKind: string }> = [];
    publisher.subscribe((event) => {
      const resolved = publisher.resolve();
      if (resolved.kind !== 'available') throw new Error('Expected the new package to be visible.');
      observed.push({ version: resolved.payload.version, changedKind: event.changedKind });
    });

    const staged = await publisher.stage({ revision: 2, bundle: await dependencyChangedBundle() });
    expect(staged).toMatchObject({ status: 'staged', changedKind: 'dependencies' });
    expect(publisher.commit(2)).toMatchObject({
      status: 'published',
      changedKind: 'dependencies',
      listenerDiagnostics: []
    });
    expect(publisher.commit(2)).toEqual({ status: 'not-staged', revision: 2 });
    expect(observed).toEqual([{ version: 2, changedKind: 'dependencies' }]);
  });

  test('isolates subscriber failures after publishing the new package', async () => {
    const publisher = new ShaderPackageHmrPublisher(
      createAssetHandle(ShaderPackageAssetType, 'shader.standard-lit')
    );
    await publisher.stage({ revision: 1, bundle: await standardLitBundle() });
    publisher.commit(1);
    let secondListenerCalls = 0;
    publisher.subscribe(() => {
      throw new Error('subscriber exploded');
    });
    publisher.subscribe(() => {
      secondListenerCalls += 1;
    });
    await publisher.stage({ revision: 2, bundle: await dependencyChangedBundle() });

    const committed = publisher.commit(2);

    expect(committed).toMatchObject({
      status: 'published',
      newVersion: 2,
      listenerDiagnostics: [
        { code: 'shader-package-listener-failed', message: 'subscriber exploded' }
      ]
    });
    expect(secondListenerCalls).toBe(1);
    expect(publisher.resolve()).toMatchObject({ kind: 'available', payload: { version: 2 } });
  });
});

function standardLitBundle() {
  return encodeCookedShaderArtifactPackage(STANDARD_LIT_SHADER_ARTIFACT, PACKAGE_OPTIONS);
}

function layoutChangedBundle() {
  return encodeCookedShaderArtifactPackage(STANDARD_LIT_SHADER_ARTIFACT, {
    ...PACKAGE_OPTIONS,
    shaderAbiVersion: PACKAGE_OPTIONS.shaderAbiVersion + 1
  });
}

function dependencyChangedBundle() {
  return encodeCookedShaderArtifactPackage(
    {
      ...STANDARD_LIT_SHADER_ARTIFACT,
      source: {
        ...STANDARD_LIT_SHADER_ARTIFACT.source,
        contentHash: '1'.repeat(64)
      }
    },
    PACKAGE_OPTIONS
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
