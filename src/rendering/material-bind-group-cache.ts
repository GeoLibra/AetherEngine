import type { RHIBindGroup, RHIDevice } from '../rhi/contracts';
import { isFactoryCanonicalKey } from './pipeline-resolver';
import type {
  MaterialBindGroupLease,
  MaterialBindGroupCacheResolution,
  PreparedMaterialBindGroups,
  RealizedMaterialBindGroups
} from './types';
import { SubmissionRetainedValue } from './submission-retained-value';

interface MaterialBindGroupCacheRecord {
  readonly bindingSet: RealizedMaterialBindGroups;
  readonly retention: SubmissionRetainedValue<RealizedMaterialBindGroups>;
}

/** Preparation-owned cache for complete device bind-group sets. */
export class MaterialBindGroupCache {
  private readonly records = new Map<string, MaterialBindGroupCacheRecord>();
  private readonly invalidatedDeviceGenerations = new Set<number>();

  /**
   * Creates or reuses the bind groups for one exact canonical identity.
   *
   * @throws When preparation facts are malformed, stale, or backend creation fails.
   */
  resolve(
    prepared: PreparedMaterialBindGroups,
    device: RHIDevice
  ): MaterialBindGroupCacheResolution {
    validatePrepared(prepared, device);
    if (this.invalidatedDeviceGenerations.has(device.generation))
      throw new Error('Material bind-group cache device generation has been invalidated.');
    const layoutIdentity = prepared.groups
      .map(({ descriptor }) => `${descriptor.layout.generation}:${descriptor.layout.id}`)
      .join(',');
    const key = `${prepared.bindingKey.canonicalValue}|${device.generation}|${layoutIdentity}`;
    const existing = this.records.get(key);
    if (existing !== undefined)
      return createResolution('hit', existing.bindingSet, existing.retention);

    const bindGroups: RHIBindGroup[] = [];
    try {
      for (const group of prepared.groups)
        bindGroups.push(device.createBindGroup(group.descriptor));
      const bindingSet = Object.freeze({
        bindingKey: prepared.bindingKey,
        bindGroups: Object.freeze(bindGroups),
        dynamicOffsets: Object.freeze([...prepared.dynamicOffsets]),
        deviceGeneration: device.generation
      });
      const retention = new SubmissionRetainedValue(bindingSet, disposeBindingSet);
      this.records.set(key, { bindingSet, retention });
      return createResolution('miss', bindingSet, retention);
    } catch (error) {
      for (const bindGroup of bindGroups) bindGroup.dispose();
      throw error;
    }
  }

  /** Disposes every bind-group set owned by one lost device generation. */
  invalidateDeviceGeneration(deviceGeneration: number): number {
    if (!Number.isSafeInteger(deviceGeneration) || deviceGeneration < 0)
      throw new Error('Material bind-group device generation must be a non-negative safe integer.');
    this.invalidatedDeviceGenerations.add(deviceGeneration);
    let invalidated = 0;
    for (const [key, record] of [...this.records]) {
      if (record.bindingSet.deviceGeneration !== deviceGeneration) continue;
      this.records.delete(key);
      record.retention.retire();
      invalidated += 1;
    }
    return invalidated;
  }
}

function createResolution(
  status: MaterialBindGroupCacheResolution['status'],
  bindingSet: RealizedMaterialBindGroups,
  retention: SubmissionRetainedValue<RealizedMaterialBindGroups>
): MaterialBindGroupCacheResolution {
  const retainedLease = retention.acquire();
  if (retainedLease === undefined)
    throw new Error('Material bind-group cache record retired during acquisition.');
  const lease: MaterialBindGroupLease = Object.freeze({
    bindingSet,
    get released() {
      return retainedLease.released;
    },
    retain: retainedLease.retain,
    release: retainedLease.release
  });
  return Object.freeze({ status, bindingSet, lease });
}

function disposeBindingSet(bindingSet: RealizedMaterialBindGroups): void {
  for (const bindGroup of bindingSet.bindGroups) bindGroup.dispose();
}

function validatePrepared(prepared: PreparedMaterialBindGroups, device: RHIDevice): void {
  if (!isFactoryCanonicalKey(prepared?.bindingKey))
    throw new Error('Material bind-group cache requires a canonical binding key.');
  if (prepared.bindingKey.parts.deviceGeneration !== device.generation)
    throw new Error('Material bind-group device generation does not match the RHI device.');
  for (let index = 0; index < prepared.groups.length; index += 1) {
    const group = prepared.groups[index];
    if (group?.group !== index)
      throw new Error('Prepared material bind groups must preserve contiguous group coordinates.');
    if (group.descriptor.layout.generation !== device.generation)
      throw new Error('Prepared material bind-group layout belongs to another device generation.');
  }
}
