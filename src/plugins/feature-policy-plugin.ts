import { definePlugin } from '../app/utils';
import {
  FeaturePolicyRuntimeController,
  type FeaturePolicyRuntimeInput
} from '../feature-policy/runtime';
import { FeaturePolicyRuntimeResource } from '../feature-policy/resources';
import type { FeaturePolicyPublication } from '../feature-policy/types';
import type {
  FeaturePolicySourceEvent,
  FeaturePolicySourceEventPort
} from '../feature-policy/events';

export interface FeaturePolicyPluginOptions {
  /** Produces the current caller-owned policy input when asynchronous staging is requested. */
  readonly input: () => FeaturePolicyRuntimeInput;
  /** Consumes publication invalidations and retains retirement until submissions complete. */
  readonly onPublication?: (publication: FeaturePolicyPublication) => void;
  /** Concrete Host, Editor, native, or product event streams that trigger restaging. */
  readonly sources?: readonly FeaturePolicySourceEventPort[];
  /** Receives dynamic restaging failures; inspection remains available on the runtime. */
  readonly onStageFailure?: (error: unknown) => void;
}

/** Creates the opt-in App owner for FeaturePolicy preparation and frame publication. */
export function createFeaturePolicyPlugin(options: FeaturePolicyPluginOptions) {
  const runtime = new FeaturePolicyRuntimeController();
  const unsubscribes: Array<() => boolean> = [];
  let staging = false;
  let restageRequested = false;
  let stopped = false;

  const requestStage = (): void => {
    if (stopped) return;
    if (staging) {
      restageRequested = true;
      return;
    }
    staging = true;
    void Promise.resolve()
      .then(() => runtime.stage(options.input()))
      .then((result) => {
        if (result.status === 'failed') options.onStageFailure?.(result.result.error);
        if (result.status === 'preparing' || result.status === 'awaiting-publish') {
          restageRequested = true;
        }
      })
      .catch((error: unknown) => options.onStageFailure?.(error))
      .finally(() => {
        staging = false;
        if (restageRequested && runtime.state === 'idle') {
          restageRequested = false;
          requestStage();
        }
      });
  };

  const handleSourceEvent = (event: FeaturePolicySourceEvent): void => {
    switch (event.kind) {
      case 'graphics-changed':
        runtime.sources.observeGraphics(event.device, event.surface);
        break;
      case 'profile-changed':
        runtime.sources.profileChanged();
        break;
      case 'registry-changed':
        runtime.sources.registryChanged();
        break;
      case 'budget-changed':
        runtime.sources.budgetChanged();
        break;
    }
    requestStage();
  };
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
          if (publication !== undefined) {
            options.onPublication?.(publication);
            if (restageRequested) {
              restageRequested = false;
              requestStage();
            }
          }
        }
      });
    },
    async prepare() {
      const result = await runtime.stage(options.input());
      if (result.status === 'failed') throw result.result.error;
      if (result.status !== 'prepared') {
        throw new Error(
          `Initial FeaturePolicy staging ended in unexpected state "${result.status}".`
        );
      }
    },
    finish() {
      for (const source of options.sources ?? []) {
        unsubscribes.push(source.subscribe(handleSourceEvent));
      }
    },
    shutdown() {
      stopped = true;
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      runtime.destroy();
    }
  });
}
