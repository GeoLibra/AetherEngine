import type { DeviceCapabilities, RHIFeature, RHIOperation } from '../contracts/capability';
import { RHIUnsupportedOperationError } from '../contracts/errors';

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
