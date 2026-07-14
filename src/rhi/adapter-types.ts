import type { RHIDevice } from './device-types';
import type {
  AdapterCapabilities,
  RHIBackend,
  RHIFeature,
  RHILimits
} from './capability-types';

export interface AdapterInfo {
  readonly name: string;
  readonly backend: RHIBackend;
  readonly vendor?: string;
  readonly architecture?: string;
}

export interface DeviceRequest {
  readonly requiredFeatures: readonly RHIFeature[];
  readonly optionalFeatures: readonly RHIFeature[];
  readonly requiredLimits?: Readonly<Partial<RHILimits>>;
  readonly label?: string;
}

export interface RHIAdapter {
  readonly info: AdapterInfo;
  readonly capabilities: AdapterCapabilities;
  requestDevice(request: DeviceRequest): Promise<RHIDevice>;
}
