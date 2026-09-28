import { describe, expect, test } from 'vitest';
import { PreparedAssetRegistry } from '../../src/rendering/world';
import type { RHISubmission, SubmissionResult } from '../../src/rhi';
import type { PreparedVariantKey } from '../../src/rendering/world';

const key: PreparedVariantKey = {
  assetId: 'mesh:primitive:0',
  payloadVersion: 4,
  deviceGeneration: 2,
  featurePolicyKey: 'desktop',
  abiVersion: 'mesh-v1'
};

describe('prepared asset residency observation', () => {
  test('reports resident, evicting, and collected states with submission ownership', async () => {
    let settle!: (result: SubmissionResult) => void;
    const submission: RHISubmission = {
      id: 1,
      status: 'pending',
      done: new Promise((resolve) => {
        settle = resolve;
      })
    };
    const registry = new PreparedAssetRegistry();
    registry.publish({ key, value: { byteLength: 96 } });
    const lease = registry.acquire<{ byteLength: number }>(key);
    if (lease === undefined) throw new Error('Published mesh variant should be acquirable.');

    expect(registry.inspect(key)).toMatchObject({
      state: 'resident',
      bytes: 96,
      activeLeases: 1,
      activeSubmissions: 0
    });
    lease.retainUntil(submission);
    registry.retire(key);
    lease.dispose();

    expect(registry.inspect(key)).toMatchObject({
      state: 'evicting',
      activeLeases: 0,
      activeSubmissions: 1
    });
    expect(registry.snapshot()).toMatchObject({
      residentVariants: 0,
      evictingVariants: 1,
      knownBytes: 96,
      unknownByteVariants: 0,
      activeLeases: 0,
      activeSubmissions: 1
    });

    settle({ status: 'completed' });
    await submission.done;
    await Promise.resolve();
    expect(registry.inspect(key)).toBeUndefined();
    expect(registry.snapshot()).toMatchObject({
      evictingVariants: 0,
      knownBytes: 0,
      activeSubmissions: 0
    });
  });

  test('marks unmeasurable payload sizes explicitly instead of reporting zero bytes', () => {
    const registry = new PreparedAssetRegistry();
    registry.publish({ key, value: { gpu: true } });

    expect(registry.inspect(key)?.bytes).toBeNull();
    expect(registry.snapshot()).toMatchObject({ knownBytes: 0, unknownByteVariants: 1 });
  });
});
