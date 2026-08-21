import { defineResource } from '../ecs/resource';
import type { FeaturePolicyRuntimeController } from './runtime';

/** App-owned FeaturePolicy orchestration state. */
export const FeaturePolicyRuntimeResource = defineResource<FeaturePolicyRuntimeController>(
  'aether.feature-policy.runtime'
);
