import type { DeviceRequest, DeviceRequestDifference } from './adapter-types';
import type { AdapterCapabilities } from './capability-types';

export function collectDeviceRequestDifferences(
  capabilities: AdapterCapabilities,
  request: DeviceRequest
): readonly DeviceRequestDifference[] {
  const missing: DeviceRequestDifference[] = [];
  for (const feature of request.requiredFeatures) {
    if (capabilities.features.get(feature)?.status === 'unsupported') {
      missing.push({ kind: 'feature', feature });
    }
  }
  for (const [limit, minimum] of Object.entries(request.requiredLimits ?? {})) {
    if (minimum === undefined) continue;
    const actual = capabilities.limits[limit];
    if (actual === undefined || actual < minimum) {
      missing.push({ kind: 'limit', limit, minimum, actual });
    }
  }
  return Object.freeze(missing);
}
