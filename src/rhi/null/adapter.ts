import type { AdapterInfo, DeviceRequest, RHIAdapter } from '../contracts/adapter';
import {
  createNullCapabilities,
  type NullCapabilityProfile
} from '../core/capabilities';
import { collectDeviceRequestDifferences } from '../core/adapter-validation';
import type { AdapterCapabilities } from '../contracts/capability';
import { RHIDeviceRequestError } from '../contracts/errors';
import { NullDevice } from './device';

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
