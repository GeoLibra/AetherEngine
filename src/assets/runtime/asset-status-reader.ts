import type { AssetHandle } from '../types';
import { AssetPayloadRegistry } from './asset-payload-registry';
import type { AssetGpuResidencyReader, AssetStatusSnapshot } from './types';

/**
 * Joins Asset Runtime CPU facts with renderer-owned GPU residency observations.
 * This reader copies diagnostic snapshots and never owns or destroys GPU resources.
 */
export class AssetStatusReader {
  constructor(
    private readonly payloads: AssetPayloadRegistry,
    private readonly gpuResidency: AssetGpuResidencyReader
  ) {}

  /** Returns one immutable CPU/GPU residency snapshot for a stable typed handle. */
  status<T>(handle: AssetHandle<T>): AssetStatusSnapshot {
    const gpu = Object.freeze(
      this.gpuResidency.inspectAsset(handle.assetId).map((variant) =>
        Object.freeze({
          key: Object.freeze({ ...variant.key }),
          state: variant.state,
          bytes: variant.bytes,
          activeLeases: variant.activeLeases,
          activeSubmissions: variant.activeSubmissions
        })
      )
    );
    return Object.freeze({
      availability: this.payloads.availability(handle),
      cpu: this.payloads.inspect(handle),
      gpu
    });
  }
}
