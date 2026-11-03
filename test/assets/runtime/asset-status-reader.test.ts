import { describe, expect, test } from 'vitest';
import { createAssetHandle, defineAssetType } from '../../../src/assets';
import { AssetPayloadRegistry, AssetStatusReader } from '../../../src/assets/runtime';
import { PreparedAssetRegistry } from '../../../src/rendering/world';
import type { PreparedVariantKey } from '../../../src/rendering/world';

interface MeshPayload {
  readonly positions: Float32Array;
}

const meshType = defineAssetType<MeshPayload>('asset.status-reader-mesh');
const handle = createAssetHandle(meshType, 'mesh:status-reader');

function variant(payloadVersion: number, deviceGeneration: number): PreparedVariantKey {
  return {
    assetId: handle.assetId,
    payloadVersion,
    deviceGeneration,
    featurePolicyKey: 'desktop-policy',
    abiVersion: 'mesh-v1'
  };
}

describe('AssetStatusReader', () => {
  test('joins immutable CPU revision facts with every GPU variant lifetime state', () => {
    const payloads = new AssetPayloadRegistry({ cpuResidentByteBudget: 64 });
    payloads.register(handle);
    const publish = (version: number) =>
      payloads.publish(
        handle,
        {
          version,
          contentHash: `sha256:mesh-${version}`,
          byteLength: 16,
          value: { positions: new Float32Array([version, 0, 0]) },
          dependencies: []
        },
        (value) => ({ positions: value.positions.slice() })
      );
    publish(1);
    const oldCpuLease = payloads.acquire(handle);
    publish(2);

    const prepared = new PreparedAssetRegistry();
    const oldVariant = variant(1, 1);
    const currentVariant = variant(2, 1);
    const restoredVariant = variant(2, 2);
    prepared.publish({ key: oldVariant, value: { byteLength: 24 } });
    prepared.publish({ key: currentVariant, value: { byteLength: 48 } });
    prepared.publish({ key: restoredVariant, value: { byteLength: 48 } });
    const oldGpuLease = prepared.acquire(oldVariant);
    prepared.retire(oldVariant);

    const reader = new AssetStatusReader(payloads, prepared);
    const status = reader.status(handle);
    expect(status).toEqual({
      availability: { kind: 'published', version: 2 },
      cpu: {
        residentBytes: 32,
        activeLeases: 1,
        revisions: [
          { version: 1, bytes: 16, activeLeases: 1, current: false },
          { version: 2, bytes: 16, activeLeases: 0, current: true }
        ]
      },
      gpu: [
        {
          key: oldVariant,
          state: 'evicting',
          bytes: 24,
          activeLeases: 1,
          activeSubmissions: 0
        },
        {
          key: currentVariant,
          state: 'resident',
          bytes: 48,
          activeLeases: 0,
          activeSubmissions: 0
        },
        {
          key: restoredVariant,
          state: 'resident',
          bytes: 48,
          activeLeases: 0,
          activeSubmissions: 0
        }
      ]
    });
    expect(Object.isFrozen(status)).toBe(true);
    expect(Object.isFrozen(status.cpu.revisions)).toBe(true);
    expect(Object.isFrozen(status.gpu)).toBe(true);

    oldCpuLease?.dispose();
    oldGpuLease?.dispose();
    expect(reader.status(handle).cpu.residentBytes).toBe(16);
    expect(reader.status(handle).gpu).toHaveLength(2);
  });
});
