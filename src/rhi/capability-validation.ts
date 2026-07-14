import type { RHIFeature, RHIOperation } from './capability-types';
import { RHIUnsupportedOperationError } from './errors';
import type { NullDeviceOwner } from './resource';

export function assertRHIFeature(
  owner: NullDeviceOwner,
  feature: RHIFeature,
  operation: RHIOperation
): void {
  const support = owner.capabilities.features.get(feature);
  if (support === undefined || support.status === 'unsupported') {
    throw new RHIUnsupportedOperationError(
      operation,
      Object.freeze([{ kind: 'feature', feature }]),
      owner.capabilities
    );
  }
}
