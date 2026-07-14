import type { DeviceCapabilities, RHIFeature, RHIOperation } from '../capability-types';
import { RHIUnsupportedOperationError } from '../errors';

export function throwWebGL2Unsupported(
  capabilities: DeviceCapabilities,
  feature: RHIFeature,
  operation: RHIOperation
): never {
  throw new RHIUnsupportedOperationError(
    operation,
    Object.freeze([{ kind: 'feature', feature }]),
    capabilities
  );
}
