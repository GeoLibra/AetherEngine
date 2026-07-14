import type {
  DeviceCapabilities,
  RHICapabilityRequirement,
  RHIOperation
} from './capability-types';

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
