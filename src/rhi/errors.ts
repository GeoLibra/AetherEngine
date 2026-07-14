import type {
  DeviceCapabilities,
  RHICapabilityRequirement,
  RHIOperation
} from './capability-types';
import type { DeviceRequestDifference } from './adapter-types';

export class RHIDeviceRequestError extends Error {
  readonly code = 'rhi/device-request-failed' as const;

  constructor(readonly missing: readonly DeviceRequestDifference[]) {
    super('RHI device request requirements are not satisfied.');
    this.name = 'RHIDeviceRequestError';
  }
}

export class RHIUnsupportedOperationError extends Error {
  readonly code = 'rhi/unsupported-operation' as const;

  constructor(
    readonly operation: RHIOperation,
    readonly required: readonly RHICapabilityRequirement[],
    readonly actual: DeviceCapabilities
  ) {
    super(`RHI operation ${operation} is unsupported by this device.`);
    this.name = 'RHIUnsupportedOperationError';
  }
}
