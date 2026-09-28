import { describe, expect, test } from 'vitest';
import { createAssetHandle, defineAssetType } from '../../../src/assets';
import { AssetPayloadRegistry } from '../../../src/assets/runtime';

interface MeshPayload {
  readonly bounds: { readonly min: number[] };
}

const MeshPayloadType = defineAssetType<MeshPayload>('asset.test-mesh');
const MaterialPayloadType = defineAssetType<{ readonly color: string }>('asset.test-material');
const handle = createAssetHandle(MeshPayloadType, 'mesh:payload-registry');
const dependency = createAssetHandle(MaterialPayloadType, 'material:payload-registry');

describe('AssetPayloadRegistry', () => {
  test('publishes an owned immutable revision and reports CPU availability separately', () => {
    const registry = new AssetPayloadRegistry();
    registry.register(handle);
    expect(registry.availability(handle)).toEqual({ kind: 'unloaded' });

    const source = { bounds: { min: [0, 1, 2] } };
    const sourceDependency = { ...dependency };
    const payload = registry.publish(
      handle,
      {
        version: 1,
        contentHash: 'sha256:mesh-v1',
        value: source,
        dependencies: [sourceDependency]
      },
      (value) => ({ bounds: { min: [...value.bounds.min] } })
    );

    source.bounds.min[0] = 99;
    sourceDependency.assetId = 'material:mutated' as typeof dependency.assetId;
    expect(registry.resolve(handle)).toMatchObject({
      kind: 'available',
      payload: {
        version: 1,
        contentHash: 'sha256:mesh-v1',
        value: { bounds: { min: [0, 1, 2] } },
        dependencies: [{ assetId: dependency.assetId, type: dependency.type }]
      }
    });
    expect(payload.dependencies[0]).not.toBe(sourceDependency);
    expect(Object.isFrozen(payload)).toBe(true);
    expect(Object.isFrozen(payload.dependencies)).toBe(true);
    expect(registry.availability(handle)).toEqual({ kind: 'published', version: 1 });
  });

  test('rejects stale revisions and caller-owned retained payloads without replacing last good', () => {
    const registry = new AssetPayloadRegistry();
    registry.register(handle);
    const original = { bounds: { min: [1] } };
    registry.publish(
      handle,
      { version: 1, contentHash: 'sha256:v1', value: original, dependencies: [] },
      (value) => ({ bounds: { min: [...value.bounds.min] } })
    );

    expect(() =>
      registry.publish(
        handle,
        { version: 1, contentHash: 'sha256:stale', value: original, dependencies: [] },
        (value) => ({ bounds: { min: [...value.bounds.min] } })
      )
    ).toThrow(/not newer/i);
    expect(() =>
      registry.publish(
        handle,
        { version: 2, contentHash: 'sha256:alias', value: original, dependencies: [] },
        (value) => value
      )
    ).toThrow(/caller-owned/i);
    expect(registry.resolve(handle)).toMatchObject({
      kind: 'available',
      payload: { version: 1, contentHash: 'sha256:v1' }
    });
  });

  test('rejects unregistered assets and conflicting type identities', () => {
    const registry = new AssetPayloadRegistry();
    expect(() =>
      registry.publish(
        handle,
        {
          version: 1,
          contentHash: 'sha256:v1',
          value: { bounds: { min: [] } },
          dependencies: []
        },
        (value) => value
      )
    ).toThrow(/not registered/i);

    registry.register(handle);
    const conflicting = createAssetHandle(MaterialPayloadType, handle.assetId);
    expect(() => registry.register(conflicting)).toThrow(/another type/i);
  });
});
