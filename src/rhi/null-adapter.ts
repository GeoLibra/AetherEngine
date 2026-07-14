import type {
  AdapterInfo,
  DeviceRequest,
  DeviceRequestDifference,
  RHIAdapter
} from './adapter-types';
import {
  createNullCapabilities,
  type NullCapabilityProfile
} from './capabilities';
import type { AdapterCapabilities } from './capability-types';
import { RHIDeviceRequestError } from './errors';
import { NullDevice } from './null/device';

export interface NullAdapterOptions extends NullCapabilityProfile {
  readonly name?: string;
}

export class NullAdapter implements RHIAdapter {
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities;

  constructor(options: NullAdapterOptions = {}) {
    this.info = Object.freeze({ name: options.name ?? 'Null Adapter', backend: 'null' });
    this.capabilities = createNullCapabilities(options);
  }

  async requestDevice(request: DeviceRequest): Promise<NullDevice> {
    const missing: DeviceRequestDifference[] = [];
    for (const feature of request.requiredFeatures) {
      if (this.capabilities.features.get(feature)?.status === 'unsupported') {
        missing.push({ kind: 'feature', feature });
      }
    }
    for (const [limit, minimum] of Object.entries(request.requiredLimits ?? {})) {
      if (minimum === undefined) continue;
      const actual = this.capabilities.limits[limit];
      if (actual === undefined || actual < minimum) {
        missing.push({ kind: 'limit', limit, minimum, actual });
      }
    }
    if (missing.length > 0) {
      throw new RHIDeviceRequestError(Object.freeze(missing));
    }
    return new NullDevice({ capabilities: this.capabilities });
  }
}
