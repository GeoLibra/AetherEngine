import type { RHIFeature } from '../contracts/capability';

export const WEBGPU_CORE_FEATURES: readonly RHIFeature[] = Object.freeze([
  'compute',
  'storage-buffer',
  'storage-texture',
  'indirect-draw'
]);
