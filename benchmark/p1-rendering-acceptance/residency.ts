import assert from 'node:assert/strict';
import { createAssetHandle, defineAssetType } from '../../src/assets';
import { AssetPayloadRegistry } from '../../src/assets/runtime';
import { PreparedAssetRegistry } from '../../src/rendering/world';
import {
  enforceCpuResidencyBudget,
  enforceGpuResidencyBudget,
  type ResidencyPressureSubject
} from '../../src/rendering/world/residency-pressure';
import { NullDevice } from '../../src/rhi/null/device';
import type { PreparedAssetLease, PreparedVariantKey } from '../../src/rendering/world';
import type { AcceptanceObservation } from './types';

/**
 * Runs real owner eviction with leases and a pending Null submission; sizes are bytes.
 * @throws When the positive four-aligned scale or owner protection/cleanup invariants are invalid.
 */
export async function observeResidency(
  count: number,
  mode: 'planner' | 'owner-scan'
): Promise<AcceptanceObservation> {
  assert.ok(Number.isSafeInteger(count) && count > 0);
  assert.equal(count % 4, 0);
  const device = new NullDevice({ submissionMode: 'manual' });
  const prepared = new PreparedAssetRegistry();
  const payloads = new AssetPayloadRegistry();
  const type = defineAssetType<{ value: number }>('acceptance-payload-v1');
  const subjects: ResidencyPressureSubject[] = [];
  const cpuLeases: Array<{ dispose(): void }> = [];
  const gpuLeases: PreparedAssetLease<unknown>[] = [];
  const submission = device.queue.submit([device.createCommandEncoder().finish()]);
  let destroyedBuffers = 0;
  for (let index = 0; index <= count; index += 1) {
    const handle = createAssetHandle(type, `asset:acceptance-${index}`);
    const key: PreparedVariantKey = {
      assetId: handle.assetId,
      payloadVersion: 1,
      deviceGeneration: device.generation,
      featurePolicyKey: 'acceptance-v1',
      abiVersion: 'v1'
    };
    const buffer = device.createBuffer({ size: 64, usage: 1 << 3 });
    prepared.publish({ key, value: { byteLength: 64, buffer } }, (value) => {
      value.buffer.dispose();
      assert.equal(value.buffer.state, 'disposed');
      destroyedBuffers += 1;
    });
    const subject = { handle, gpuVariants: [key], priority: 0, lastUseTick: index, rebuildCost: 1 };
    subjects.push(subject);
    if (index === count) continue; // Extra device bytes are absent from initial candidates.
    payloads.register(handle);
    payloads.publish(
      handle,
      {
        version: 1,
        contentHash: `v1-${index}`,
        byteLength: 32,
        value: { value: index },
        dependencies: []
      },
      (value) => ({ ...value })
    );
    if (index % 2 === 0) {
      const lease = payloads.acquire(handle);
      assert.ok(lease);
      cpuLeases.push(lease);
    }
    if (index % 4 < 2) {
      const lease = prepared.acquire(key);
      assert.ok(lease);
      if (index % 4 === 0) gpuLeases.push(lease);
      else {
        lease.retainUntil(submission);
        lease.dispose();
      }
    }
  }
  const candidates = subjects.slice(0, count);
  const first = enforce(candidates);
  assert.deepEqual(first, {
    cpuReleased: count * 16,
    cpuRemaining: count * 16,
    gpuReleased: count * 32,
    gpuRemaining: count * 32 + 64
  });
  assert.equal(prepared.snapshot().activeLeases, count / 4);
  assert.equal(prepared.snapshot().activeSubmissions, count / 4);
  assert.equal(destroyedBuffers, count / 2);
  for (const lease of cpuLeases) lease.dispose();
  for (const lease of gpuLeases) lease.dispose();
  device.queue.completeNextForTesting();
  await submission.done;
  await Promise.resolve();
  const second = enforce(subjects);
  assert.deepEqual(second, {
    cpuReleased: count * 16,
    cpuRemaining: 0,
    gpuReleased: count * 32 + 64,
    gpuRemaining: 0
  });
  assert.equal(prepared.snapshot().knownBytes, 0);
  assert.equal(payloads.residentBytes, 0);
  assert.equal(destroyedBuffers, count + 1);
  device.destroy();
  const counters = {
    assets: count,
    protectedCpu: count / 2,
    protectedGpuLeases: count / 4,
    protectedGpuSubmissions: count / 4,
    unlistedGpuBytes: 64,
    destroyedBuffers,
    firstCpuReleased: first.cpuReleased,
    firstGpuReleased: first.gpuReleased,
    finalCpuBytes: 0,
    finalGpuBytes: 0
  };
  return { checksum: JSON.stringify(counters), counters };

  function enforce(inventory: readonly ResidencyPressureSubject[]) {
    if (mode === 'planner') {
      const cpu = enforceCpuResidencyBudget(payloads, 0, inventory);
      const gpu = enforceGpuResidencyBudget(prepared, device.generation, 0, inventory);
      return {
        cpuReleased: cpu.releasedBytes,
        cpuRemaining: cpu.remainingPressureBytes,
        gpuReleased: gpu.releasedBytes,
        gpuRemaining: gpu.remainingPressureBytes
      };
    }
    // Lower-bound comparator: owners still validate leases; it omits planner priority ordering.
    const cpuBefore = payloads.residentBytes;
    const gpuBefore = prepared.snapshot().knownBytes;
    for (const subject of inventory) {
      if (payloads.inspect(subject.handle).revisions.length > 0) payloads.evict(subject.handle);
      for (const key of subject.gpuVariants) prepared.evictUnreferenced(key);
    }
    return {
      cpuReleased: cpuBefore - payloads.residentBytes,
      cpuRemaining: payloads.residentBytes,
      gpuReleased: gpuBefore - prepared.snapshot().knownBytes,
      gpuRemaining: prepared.snapshot().knownBytes
    };
  }
}
