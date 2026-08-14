import { createCapabilitySnapshot, RHI_FEATURES } from '../core/capabilities';
import type { AdapterCapabilities, FeatureSupport, RHIFeature } from '../contracts/capability';
import { WEBGPU_CORE_FEATURES } from '../webgpu/core-features';
import type { NativeDawnAdapterPort } from './types';

const NATIVE_QUEUES = Object.freeze([
  Object.freeze({ role: 'graphics' as const, status: 'native' as const }),
  Object.freeze({ role: 'compute' as const, status: 'native' as const }),
  Object.freeze({ role: 'transfer' as const, status: 'native' as const })
]);

export function createNativeDawnCapabilities(
  native: NativeDawnAdapterPort,
  selectedExtensions: ReadonlySet<RHIFeature>
): AdapterCapabilities {
  const features = new Map<RHIFeature, FeatureSupport>();
  for (const feature of RHI_FEATURES) {
    // Dawn implements the portable WebGPU core directly; only extension features need selection.
    if (WEBGPU_CORE_FEATURES.includes(feature)) {
      features.set(feature, { status: 'native' });
    } else if (
      feature === 'timestamp-query' &&
      native.features.has(feature) &&
      selectedExtensions.has(feature)
    ) {
      features.set(feature, { status: 'native' });
    } else {
      features.set(feature, {
        status: 'unsupported',
        reason: native.features.has(feature)
          ? 'Dawn feature was not selected for this device.'
          : 'Dawn adapter does not report this feature.'
      });
    }
  }
  return createCapabilitySnapshot({
    backend: 'native',
    features,
    limits: native.limits,
    formats: native.formats,
    queues: NATIVE_QUEUES
  });
}
