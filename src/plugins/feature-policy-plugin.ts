import { definePlugin } from '../app/utils';
import {
  FeaturePolicyRuntimeController,
  type FeaturePolicyRuntimeInput
} from '../feature-policy/runtime';
import { FeaturePolicyRuntimeResource } from '../feature-policy/resources';
import type { FeaturePolicyPublication } from '../feature-policy/types';

export interface FeaturePolicyPluginOptions {
  /** Produces the current caller-owned policy input when asynchronous staging is requested. */
  readonly input: () => FeaturePolicyRuntimeInput;
  /** Consumes publication invalidations and retains retirement until submissions complete. */
  readonly onPublication?: (publication: FeaturePolicyPublication) => void;
}

/** Creates the opt-in App owner for FeaturePolicy preparation and frame publication. */
export function createFeaturePolicyPlugin(options: FeaturePolicyPluginOptions) {
  const runtime = new FeaturePolicyRuntimeController();
  return definePlugin({
    id: 'aether.feature-policy',
    build(builder) {
      builder.insertResource(FeaturePolicyRuntimeResource, runtime);
      builder.addSystem('PreRender', {
        id: 'aether.feature-policy.publish',
        writes: [FeaturePolicyRuntimeResource],
        run(world) {
          const owned = world.getResource(FeaturePolicyRuntimeResource);
          if (owned === undefined) {
            throw new Error('FeaturePolicy runtime resource is missing at frame publication.');
          }
          const publication = owned.publishFrameBoundary();
          if (publication !== undefined) options.onPublication?.(publication);
        }
      });
    },
    async finish() {
      const result = await runtime.stage(options.input());
      if (result.status === 'failed') throw result.result.error;
      if (result.status !== 'prepared') {
        throw new Error(
          `Initial FeaturePolicy staging ended in unexpected state "${result.status}".`
        );
      }
    },
    shutdown() {
      runtime.destroy();
    }
  });
}
