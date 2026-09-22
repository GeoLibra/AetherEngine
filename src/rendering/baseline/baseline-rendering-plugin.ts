import { FeaturePolicyRuntimeResource } from '../../feature-policy/resources';
import type { Plugin, AppBuilder } from '../../app/types';
import { serviceValue } from '../../app/utils';
import { defineResource } from '../../ecs/resource';
import { CameraRenderSource } from '../camera';
import { DirectionalLightSource, PointLightSource, SpotLightSource } from '../lighting';
import { MeshRenderSource } from '../mesh';
import { WorldTransform } from '../../transform';
import type { BaselineRenderDiagnostics, BaselineRenderingOptions } from './types';
import { assertGraphicsReady, validateOptions } from './baseline-options';
import type { ViewBackground } from '../background/types';
import {
  BaselineBackgroundControlImpl,
  BaselineBackgroundControlResource,
  BaselineBackgroundService,
  type BaselineBackgroundControl
} from './baseline-background-control';
import { BaselineRenderingRuntime } from './baseline-rendering-runtime';

export { BaselineRenderingRuntime } from './baseline-rendering-runtime';

/** Latest immutable baseline frame outcome published by the rendering plugin. */
export const BaselineRenderDiagnosticsResource = defineResource<BaselineRenderDiagnostics>(
  'aether.rendering.baseline.diagnostics'
);

/**
 * Formal plugin interface for baseline rendering exposing typed runtime controls.
 */
export interface BaselineRenderingPlugin extends Plugin {
  /** Strongly typed background runtime control resource registered in App. */
  readonly backgroundControl: BaselineBackgroundControl;
  /**
   * Replaces the view background configuration at runtime.
   * Delegates to `backgroundControl.setBackground(bg)`.
   */
  setBackground(bg: ViewBackground): void;
  /**
   * Dynamically updates the active environment intensity without rebuilding GPU pipelines.
   */
  setEnvironmentIntensity(intensity: number): void;
}

/** Creates the opt-in owner for the single-view baseline rendering composition. */
export function createBaselineRenderingPlugin(
  options: BaselineRenderingOptions
): BaselineRenderingPlugin {
  const validated = validateOptions(options);
  const runtime = new BaselineRenderingRuntime(validated);
  const backgroundControl = new BaselineBackgroundControlImpl();
  let unsubscribe: (() => boolean) | undefined;

  const plugin: BaselineRenderingPlugin = {
    id: 'aether.baseline-rendering',
    backgroundControl,
    setBackground(bg: ViewBackground): void {
      backgroundControl.setBackground(bg);
    },
    setEnvironmentIntensity(intensity: number): void {
      runtime.setEnvironmentIntensity(intensity);
    },
    build(builder) {
      builder.insertResource(BaselineRenderDiagnosticsResource, runtime.diagnostics);
      builder.insertResource(BaselineBackgroundControlResource, backgroundControl);
      builder.provideService(
        BaselineBackgroundService,
        serviceValue<BaselineBackgroundControl>(backgroundControl)
      );
      builder.addSystem('PreStartup', {
        id: 'aether.baseline-rendering.register-components',
        run(world) {
          world
            .registerComponent(WorldTransform)
            .registerComponent(CameraRenderSource)
            .registerComponent(MeshRenderSource)
            .registerComponent(DirectionalLightSource)
            .registerComponent(PointLightSource)
            .registerComponent(SpotLightSource);
        }
      });
      builder.addSystem('PreRender', {
        id: 'aether.baseline-rendering.prepare',
        writes: [BaselineRenderDiagnosticsResource, BaselineBackgroundControlResource],
        optionalAfter: ['aether.feature-policy.publish'],
        run(world) {
          const control = world.getResource(BaselineBackgroundControlResource);
          if (control === undefined)
            throw new Error('Baseline background control resource is missing.');
          if (control.consumeDirty()) {
            runtime.updateBackground(control.current);
          }
          const policyRuntime = world.getResource(FeaturePolicyRuntimeResource);
          if (policyRuntime !== undefined) {
            const publication = policyRuntime.publication;
            if (publication !== undefined) {
              runtime.updateFeaturePolicy(publication);
            } else if (policyRuntime.current !== undefined) {
              runtime.updateFeaturePolicy(policyRuntime.current);
            }
          }
          runtime.prepare(world);
        }
      });
      builder.addSystem('Render', {
        id: 'aether.baseline-rendering.frame',
        writes: [BaselineRenderDiagnosticsResource],
        run(world) {
          world.replaceResource(BaselineRenderDiagnosticsResource, runtime.frame());
        }
      });
    },
    finish() {
      assertGraphicsReady(validated.graphics);
      runtime.initializePreparation();
      unsubscribe = validated.graphics.subscribe(() => runtime.invalidate());
    },
    shutdown() {
      backgroundControl.dispose();
      unsubscribe?.();
      unsubscribe = undefined;
      return runtime.dispose();
    }
  };

  return Object.freeze(plugin);
}
