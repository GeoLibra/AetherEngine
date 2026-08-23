import type { RHIBindGroup, RHIDevice } from '../rhi/contracts';
import { isFactoryCanonicalKey } from './pipeline-resolver';
import type {
  MaterialBindGroupCacheResolution,
  PreparedMaterialBindGroups,
  RealizedMaterialBindGroups
} from './types';

/** Preparation-owned cache for complete device bind-group sets. */
export class MaterialBindGroupCache {
  private readonly records = new Map<string, RealizedMaterialBindGroups>();

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
    const key = `${prepared.bindingKey.canonicalValue}|${device.generation}`;
    const existing = this.records.get(key);
    if (existing !== undefined) return Object.freeze({ status: 'hit', bindingSet: existing });

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
      this.records.set(key, bindingSet);
      return Object.freeze({ status: 'miss', bindingSet });
    } catch (error) {
      for (const bindGroup of bindGroups) bindGroup.dispose();
      throw error;
    }
  }

  /** Disposes every bind-group set owned by one lost device generation. */
  invalidateDeviceGeneration(deviceGeneration: number): number {
    let invalidated = 0;
    for (const [key, bindingSet] of this.records) {
      if (bindingSet.deviceGeneration !== deviceGeneration) continue;
      for (const bindGroup of bindingSet.bindGroups) bindGroup.dispose();
      this.records.delete(key);
      invalidated += 1;
    }
    return invalidated;
  }
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
