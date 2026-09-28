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
        byteLength: 64,
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
      { version: 1, contentHash: 'sha256:v1', byteLength: 8, value: original, dependencies: [] },
      (value) => ({ bounds: { min: [...value.bounds.min] } })
    );

    expect(() =>
      registry.publish(
        handle,
        {
          version: 1,
          contentHash: 'sha256:stale',
          byteLength: 8,
          value: original,
          dependencies: []
        },
        (value) => ({ bounds: { min: [...value.bounds.min] } })
      )
    ).toThrow(/not newer/i);
    expect(() =>
      registry.publish(
        handle,
        {
          version: 2,
          contentHash: 'sha256:alias',
          byteLength: 8,
          value: original,
          dependencies: []
        },
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
          byteLength: 4,
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

  test('pins old revisions until the last lease releases and accounts resident bytes', () => {
    const registry = new AssetPayloadRegistry({ cpuResidentByteBudget: 16 });
    registry.register(handle);
    const publish = (version: number) =>
      registry.publish(
        handle,
        {
          version,
          contentHash: `sha256:v${version}`,
          byteLength: 8,
          value: { bounds: { min: [version] } },
          dependencies: []
        },
        (value) => ({ bounds: { min: [...value.bounds.min] } })
      );
    const first = publish(1);
    const firstLease = registry.acquire(handle);
    const secondLease = registry.acquire(handle);
    expect(firstLease?.payload).toBe(first);
    expect(secondLease?.payload).toBe(first);

    const second = publish(2);
    const currentLease = registry.acquire(handle);
    expect(registry.resolve(handle)).toMatchObject({ kind: 'available', payload: { version: 2 } });
    expect(firstLease?.payload).toBe(first);
    expect(registry.residentBytes).toBe(16);
    expect(registry.evict(handle)).toEqual({ kind: 'leased', version: 2, leaseCount: 1 });

    firstLease?.dispose();
    expect(registry.residentBytes).toBe(16);
    secondLease?.dispose();
    expect(registry.residentBytes).toBe(8);
    currentLease?.dispose();
    expect(registry.evict(handle)).toEqual({ kind: 'evicted', version: 2, bytes: 8 });
    expect(registry.residentBytes).toBe(0);
    expect(registry.availability(handle)).toEqual({ kind: 'unloaded' });
    expect(second.version).toBe(2);
    expect(() =>
      registry.publish(
        handle,
        {
          version: 2,
          contentHash: 'sha256:stale-after-eviction',
          byteLength: 8,
          value: { bounds: { min: [2] } },
          dependencies: []
        },
        (value) => ({ bounds: { min: [...value.bounds.min] } })
      )
    ).toThrow(/not newer/i);
  });

  test('reclaims an unleased old revision but rejects over-budget replacement atomically', () => {
    const options = { cpuResidentByteBudget: 8 };
    const registry = new AssetPayloadRegistry(options);
    options.cpuResidentByteBudget = 64;
    registry.register(handle);
    const publish = (version: number, byteLength: number) =>
      registry.publish(
        handle,
        {
          version,
          contentHash: `sha256:v${version}`,
          byteLength,
          value: { bounds: { min: [version] } },
          dependencies: []
        },
        (value) => ({ bounds: { min: [...value.bounds.min] } })
      );

    publish(1, 8);
    publish(2, 8);
    expect(registry.residentBytes).toBe(8);
    expect(registry.resolve(handle)).toMatchObject({ kind: 'available', payload: { version: 2 } });
    expect(() => publish(3, 9)).toThrow(/exceeds the resident byte budget/i);
    expect(registry.residentBytes).toBe(8);
    expect(registry.resolve(handle)).toMatchObject({ kind: 'available', payload: { version: 2 } });
    expect(() => publish(2, 8)).toThrow(/not newer/i);
  });
});
