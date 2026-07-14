import type { AdapterInfo, DeviceRequest, RHIAdapter } from './adapter-types';
import {
  createNullCapabilities,
  type NullCapabilityProfile
} from './capabilities';
import type { AdapterCapabilities } from './capability-types';
import { RHIDeviceRequestError } from './errors';
import { NullDevice } from './null/device';
import { collectDeviceRequestDifferences } from './adapter-validation';

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
    const missing = collectDeviceRequestDifferences(this.capabilities, request);
    if (missing.length > 0) {
      throw new RHIDeviceRequestError(Object.freeze(missing));
    }
    return new NullDevice({ capabilities: this.capabilities });
  }
}
