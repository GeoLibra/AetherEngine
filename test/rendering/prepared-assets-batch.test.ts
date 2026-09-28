import { describe, expect, test } from 'vitest';
import { PreparedAssetRegistry } from '../../src';

const key = (assetId: string) => ({
  assetId,
  payloadVersion: 1,
  deviceGeneration: 7,
  featurePolicyKey: 'policy',
  abiVersion: 'mesh-v1'
});

describe('prepared asset batch publication', () => {
  test('publishes every variant in one synchronous transaction', () => {
    const registry = new PreparedAssetRegistry();
    registry.publishBatch([
      { key: key('mesh/0'), value: 10 },
      { key: key('mesh/1'), value: 20 }
    ]);
    const first = registry.acquire<number>(key('mesh/0'));
    const second = registry.acquire<number>(key('mesh/1'));
    expect([first?.prepared.value, second?.prepared.value]).toEqual([10, 20]);
    first?.dispose();
    second?.dispose();
  });

  test('rejects an existing or intra-batch key before publishing any new variant', () => {
    const registry = new PreparedAssetRegistry();
    registry.publish({ key: key('mesh/existing'), value: 1 });
    expect(() =>
      registry.publishBatch([
        { key: key('mesh/new'), value: 2 },
        { key: key('mesh/existing'), value: 3 }
      ])
    ).toThrow(/already exists/i);
    expect(registry.acquire(key('mesh/new'))).toBeUndefined();
    expect(() =>
      registry.publishBatch([
        { key: key('mesh/new'), value: 2 },
        { key: key('mesh/new'), value: 3 }
      ])
    ).toThrow(/duplicate/i);
    expect(registry.acquire(key('mesh/new'))).toBeUndefined();
  });
});
