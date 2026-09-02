import type { DeviceCapabilities, RHICapabilityRequirement, RHIOperation } from './capability';
import type { DeviceRequestDifference } from './adapter';

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

export class WebGPUNativeDeviceRequestError extends Error {
  readonly code = 'rhi/webgpu-device-request-failed' as const;

  constructor(
    readonly adapterName: string,
    readonly deviceLabel: string | undefined,
    override readonly cause: unknown
  ) {
    super(
      `WebGPU adapter "${adapterName}" failed to create device "${deviceLabel ?? 'unlabeled'}".`
    );
    this.name = 'WebGPUNativeDeviceRequestError';
  }
}

export class WebGPUNativeOperationError extends Error {
  readonly code = 'rhi/webgpu-native-operation-failed' as const;

  constructor(
    readonly operation: string,
    readonly resourceLabel: string | undefined,
    override readonly cause: unknown
  ) {
    super(`WebGPU operation ${operation} failed for "${resourceLabel ?? 'unlabeled'}".`);
    this.name = 'WebGPUNativeOperationError';
  }
}
