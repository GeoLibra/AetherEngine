import { expect, test } from 'vitest';
import { PreparedAssetRegistry } from '../../src/rendering/world/prepared-assets';
import {
  enforceCpuResidencyBudget,
  enforceGpuResidencyBudget
} from '../../src/rendering/world/residency-pressure';
import { AssetPayloadRegistry } from '../../src/assets/runtime';

test('reclaims CPU pressure after the final CPU lease releases its revision', () => {
  const payloads = new AssetPayloadRegistry();
  const handle = createAssetHandle(
    defineAssetType<{ value: number }>('pressure-cpu'),
    'asset:pressure-cpu'
  );
  payloads.register(handle);
  payloads.publish(
    handle,
    { version: 1, contentHash: 'cpu-v1', byteLength: 8, value: { value: 1 }, dependencies: [] },
    (value) => ({ ...value })
  );
  const subjects = [{ handle, gpuVariants: [], priority: 0, lastUseTick: 1, rebuildCost: 1 }];
  const lease = payloads.acquire(handle);
  if (lease === undefined) throw new Error('Published CPU payload must be acquirable.');
  expect(enforceCpuResidencyBudget(payloads, 0, subjects)).toEqual({
    releasedBytes: 0,
    remainingPressureBytes: 8
  });
  lease.dispose();
  expect(enforceCpuResidencyBudget(payloads, 0, subjects)).toEqual({
    releasedBytes: 8,
    remainingPressureBytes: 0
  });
  expect(payloads.availability(handle)).toEqual({ kind: 'unloaded' });
});
import { createAssetHandle, defineAssetType } from '../../src/assets';

test('counts device-owned bytes absent from the caller eviction candidate list', () => {
  const registry = new PreparedAssetRegistry();
  registry.publish({
    key: {
      assetId: 'asset:unlisted',
      payloadVersion: 1,
      deviceGeneration: 1,
      featurePolicyKey: 'default',
      abiVersion: 'v1'
    },
    value: { byteLength: 16 }
  });
  expect(enforceGpuResidencyBudget(registry, 1, 0, [])).toEqual({
    releasedBytes: 0,
    remainingPressureBytes: 16
  });
  expect(enforceGpuResidencyBudget(registry, 2, 0, [])).toEqual({
    releasedBytes: 0,
    remainingPressureBytes: 0
  });
});

test('enforces device GPU budget while retaining a pinned variant and CPU identity', () => {
  const registry = new PreparedAssetRegistry();
  const handle = createAssetHandle(
    defineAssetType<unknown>('pressure-mesh'),
    'asset:pressure-mesh'
  );
  const key = {
    assetId: handle.assetId,
    payloadVersion: 1,
    deviceGeneration: 1,
    featurePolicyKey: 'default',
    abiVersion: 'v1'
  };
  registry.publish({ key, value: { byteLength: 16 } });
  const subjects = [{ handle, gpuVariants: [key], priority: 0, lastUseTick: 1, rebuildCost: 1 }];
  const lease = registry.acquire(key)!;
  expect(enforceGpuResidencyBudget(registry, 1, 0, subjects)).toEqual({
    releasedBytes: 0,
    remainingPressureBytes: 16
  });
  lease.dispose();
  expect(enforceGpuResidencyBudget(registry, 1, 0, subjects)).toEqual({
    releasedBytes: 16,
    remainingPressureBytes: 0
  });
  expect(registry.inspect(key)).toBeUndefined();
});
