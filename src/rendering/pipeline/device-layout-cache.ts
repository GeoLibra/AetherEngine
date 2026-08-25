import type {
  GPUBindGroupLayoutDescriptor,
  RHIBindGroupLayout,
  RHIDevice,
  RHIPipelineLayout
} from '../../rhi/contracts';
import { lowerBindingLayoutPlan } from './binding-layout-lowering';
import type {
  DeviceLayoutCacheResolution,
  DeviceLayoutRealization,
  BindingLayoutPlan,
  LayoutCacheEntry,
  WebGpuBindingLayoutPlan
} from './types';

const EMPTY_BINDING_ENTRIES = Object.freeze([]);
const EMPTY_BIND_GROUP_LAYOUT_DESCRIPTOR: GPUBindGroupLayoutDescriptor = Object.freeze({
  entries: EMPTY_BINDING_ENTRIES
});

interface DeviceLayoutRecord {
  readonly deviceGeneration: number;
  readonly realization: DeviceLayoutRealization;
}

/**
 * Owns device-native layout objects created from validated CPU specialization entries.
 *
 * Creation belongs to renderer preparation. Queue and draw code must only consume the
 * published realization and must never call this cache.
 */
export class DeviceLayoutCache {
  private readonly records = new Map<string, DeviceLayoutRecord>();

  /**
   * Returns or creates the exact RHI layout realization for a CPU cache entry.
   *
   * @throws When the entry targets a different device generation or RHI creation fails.
   */
  resolve(entry: LayoutCacheEntry, device: RHIDevice): DeviceLayoutCacheResolution {
    if (entry.deviceGeneration !== device.generation)
      throw new Error('Device layout entry device generation does not match the RHI device.');
    if (entry.lowering.kind === 'unsupported')
      return Object.freeze({
        status: 'unsupported',
        diagnostic: entry.lowering.diagnostic
      });

    const key = cacheKey(entry);
    const existing = this.records.get(key);
    if (existing !== undefined)
      return Object.freeze({ status: 'hit', layout: existing.realization });

    const descriptors = portableDescriptors(entry);
    const bindGroupLayouts: RHIBindGroupLayout[] = [];
    try {
      const highestGroup = entry.plan.groups.at(-1)?.group ?? -1;
      for (let group = 0; group <= highestGroup; group += 1)
        bindGroupLayouts.push(
          device.createBindGroupLayout(descriptors.get(group) ?? EMPTY_BIND_GROUP_LAYOUT_DESCRIPTOR)
        );
      const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts });
      const realization = publishRealization(
        entry.plan.id,
        entry.plan.hash,
        bindGroupLayouts,
        pipelineLayout
      );
      this.records.set(key, { deviceGeneration: device.generation, realization });
      return Object.freeze({ status: 'miss', layout: realization });
    } catch (error) {
      for (const layout of bindGroupLayouts) layout.dispose();
      throw error;
    }
  }

  /** Disposes and removes every native layout owned by one lost device generation. */
  invalidateDeviceGeneration(deviceGeneration: number): number {
    let invalidated = 0;
    for (const [key, record] of this.records) {
      if (record.deviceGeneration !== deviceGeneration) continue;
      record.realization.pipelineLayout.dispose();
      for (const layout of record.realization.bindGroupLayouts) layout.dispose();
      this.records.delete(key);
      invalidated += 1;
    }
    return invalidated;
  }
}

function cacheKey(entry: LayoutCacheEntry): string {
  return [
    entry.plan.id,
    entry.plan.hash,
    entry.layoutRevision,
    entry.featurePolicyHash,
    entry.target,
    entry.deviceGeneration
  ].join('|');
}

function portableDescriptors(entry: LayoutCacheEntry): Map<number, GPUBindGroupLayoutDescriptor> {
  const webGpuPlan =
    entry.lowering.kind === 'webgpu'
      ? entry.lowering
      : (lowerBindingLayoutPlan(entry.plan, 'webgpu') as WebGpuBindingLayoutPlan);
  return new Map(webGpuPlan.groups.map((group) => [group.group, group.descriptor]));
}

function publishRealization(
  bindingLayoutId: BindingLayoutPlan['id'],
  bindingLayoutHash: string,
  bindGroupLayouts: RHIBindGroupLayout[],
  pipelineLayout: RHIPipelineLayout
): DeviceLayoutRealization {
  return Object.freeze({
    bindingLayoutId,
    bindingLayoutHash,
    bindGroupLayouts: Object.freeze([...bindGroupLayouts]),
    pipelineLayout
  });
}
