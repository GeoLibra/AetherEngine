import type { RHIFeature, RHIOperation } from '../contracts/capability';
import { RHIUnsupportedOperationError } from '../contracts/errors';
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
