import type { Plugin, AppBuilder } from '../../app/types';
import { serviceValue } from '../../app/utils';
import { defineResource } from '../../ecs/resource';
import type { Entity } from '../../ecs/types';
import type { World } from '../../ecs/world';
import { CameraRenderSource, CameraRenderExtractor, CameraViewExtraction } from '../camera';
import {
  DirectionalLightExtraction,
  DirectionalLightExtractor,
  DirectionalLightSource
} from '../lighting';
import { prepareBaselinePostColor, type BaselinePostColorPreparation } from './baseline-post-color';
import type { RHIResource } from '../../rhi/contracts';
import {
  MeshAssetField,
  MeshMaterialsField,
  MeshRenderExtraction,
  MeshRenderExtractor,
  MeshRenderSource,
  MeshTransformField,
  MeshVisibilityField,
  MeshWorldBoundsField,
  type RenderMaterialBinding,
  type RenderMeshFact,
  type RenderTransformFact
} from '../mesh';
import type { MeshBounds } from '../../geometry';
import type { RenderVisibilityFact } from '../mesh';
import { computeVisibility } from '../visibility';
import { RenderExtractorRegistryBuilder, RenderWorld } from '../world';
import { WorldTransform } from '../../transform';
import { BaselineRenderer } from './baseline-renderer';
import { BaselineStandardLitPreparation } from './baseline-preparation';
import type {
  BaselinePreparedFrame,
  BaselineRenderDiagnostics,
  BaselineRenderSkipReason,
  BaselineRenderingOptions
} from './types';
import {
  assertGraphicsReady,
  createBaselineBackgroundFrame,
  validateBackgroundOption,
  validateOptions,
  type NormalizedBaselineRenderingOptions
} from './baseline-options';
import type { ViewBackground } from '../background/types';
import {
  BaselineBackgroundControlImpl,
  BaselineBackgroundControlResource,
  BaselineBackgroundService,
  type BaselineBackgroundControl
} from './baseline-background-control';

const EMPTY_PACKETS = Object.freeze([]);

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
            .registerComponent(DirectionalLightSource);
        }
      });
      builder.addSystem('PreRender', {
        id: 'aether.baseline-rendering.prepare',
        writes: [BaselineRenderDiagnosticsResource, BaselineBackgroundControlResource],
        run(world) {
          const control = world.getResource(BaselineBackgroundControlResource);
          if (control === undefined)
            throw new Error('Baseline background control resource is missing.');
          if (control.consumeDirty()) {
            runtime.updateBackground(control.current);
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

class BaselineRenderingRuntime {
  private readonly renderer: BaselineRenderer;
  private renderWorld: RenderWorld | undefined;
  private meshExtraction: MeshRenderExtraction | undefined;
  private lightExtraction: DirectionalLightExtraction | undefined;
  private cameraExtraction: CameraViewExtraction | undefined;
  private standardLit: BaselineStandardLitPreparation | undefined;
  private standalonePostColor: BaselinePostColorPreparation | undefined;
  private standalonePostColorResources: readonly RHIResource[] = [];
  private prepared: BaselinePreparedFrame | undefined;
  private preparedSkip: BaselineRenderSkipReason | undefined;
  private backgroundOverride: ViewBackground | undefined;
  private sourceTick = 0;
  private disposed = false;
  diagnostics: BaselineRenderDiagnostics;

  constructor(private readonly options: NormalizedBaselineRenderingOptions) {
    this.renderer = new BaselineRenderer(options);
    this.diagnostics = Object.freeze({
      frame: 0,
      viewId: options.viewId,
      status: 'idle',
      deviceGeneration: options.graphics.device.generation,
      surfaceGeneration: options.graphics.surface.generation
    });
  }

  prepare(world: World): void {
    this.assertLive();
    this.initialize(world);
    const sourceTick = ++this.sourceTick;
    const transforms = collectTransforms(world);
    this.meshExtraction!.extract({ sourceTick, transforms }).release();
    this.lightExtraction!.extract({ sourceTick }).release();
    const cameras = [...world.query([CameraRenderSource])]
      .map(([entity]) => entity)
      .sort((left, right) => left - right);
    const configuration = this.options.graphics.surface.configuration;
    const suspended =
      configuration !== undefined && (configuration.width === 0 || configuration.height === 0);
    const bindings =
      cameras[0] === undefined || configuration === undefined || suspended
        ? []
        : [
            {
              camera: cameras[0],
              viewId: this.options.viewId,
              surface: 'main',
              logicalWidth: configuration.width,
              logicalHeight: configuration.height,
              devicePixelRatio: 1,
              featurePolicyKey: this.options.featurePolicyKey
            }
          ];
    const camera = this.cameraExtraction!.extract({ sourceTick, transforms, bindings });
    const view = camera.visibilityViews[0];
    if (suspended) {
      this.discardPrepared();
      this.preparedSkip = 'surface-suspended';
      this.prepared = undefined;
      camera.revision.release();
      return;
    }
    if (view === undefined) {
      this.discardPrepared();
      this.prepared = undefined;
      camera.revision.release();
      return;
    }
    if (this.standardLit === undefined) {
      if (this.standalonePostColor === undefined && configuration !== undefined) {
        const { preparation, ownedResources } = prepareBaselinePostColor(
          this.options.graphics.device,
          configuration.format
        );
        this.standalonePostColor = preparation;
        this.standalonePostColorResources = ownedResources;
      }
      const background = createBaselineBackgroundFrame(
        this.options.graphics.device,
        camera.views[0]!,
        this.options,
        this.backgroundOverride
      );
      // Acquire the replacement's texture lease before retiring the previous frame.
      // This keeps unchanged environment textures resident across warm frames.
      this.discardPrepared();
      this.prepared = Object.freeze({
        status: 'ready',
        view,
        packets: EMPTY_PACKETS,
        ...(background === undefined ? {} : { background }),
        ...(this.standalonePostColor === undefined ? {} : { postColor: this.standalonePostColor }),
        deviceGeneration: this.options.graphics.device.generation,
        surfaceGeneration: this.options.graphics.surface.generation
      });
      camera.revision.release();
      return;
    }
    const candidates = [...camera.revision.snapshot].flatMap(([entity, fields]) => {
      const bounds = fields.get(MeshWorldBoundsField) as MeshBounds | undefined;
      const visibility = fields.get(MeshVisibilityField) as RenderVisibilityFact | undefined;
      if (bounds === undefined || visibility === undefined) return [];
      return [
        {
          entity,
          layerMask: visibility.layerMask,
          enabled: visibility.visible,
          bounds: { kind: 'sphere' as const, ...bounds.sphere },
          boundsRevision: camera.revision.revision
        }
      ];
    });
    const visible = computeVisibility(view, candidates).items;
    const matching = visible.filter(({ renderEntity }) =>
      this.matchesRegistration(camera.revision, renderEntity)
    );
    const lights = this.lightExtraction!.lights().filter(
      (candidate) => candidate.enabled && (candidate.layerMask & view.layerMask) !== 0
    );
    const packets = matching.map((selected) => {
      const transform = camera.revision.snapshot
        .get(selected.renderEntity)
        ?.get(MeshTransformField) as RenderTransformFact | undefined;
      if (transform === undefined)
        throw new Error('Visible baseline mesh is missing its transform.');
      return this.standardLit!.createPacket({
        entity: selected.renderEntity,
        transform,
        view: camera.views[0]!
      });
    });
    const receivers = matching.map(({ renderEntity }) => {
      const candidate = candidates.find(({ entity }) => entity === renderEntity);
      if (candidate === undefined) throw new Error('Visible baseline receiver is missing bounds.');
      return Object.freeze({
        renderEntity,
        layerMask: candidate.layerMask,
        enabled: candidate.enabled,
        bounds: candidate.bounds
      });
    });
    const lightList = this.standardLit.createLightListFrame({
      viewLayerMask: view.layerMask,
      lights,
      receivers
    });
    const background = this.standardLit.createBackgroundFrame(
      camera.views[0]!,
      this.backgroundOverride
    );
    this.discardPrepared();
    this.prepared = Object.freeze({
      status: 'ready',
      view,
      packets: Object.freeze(packets),
      environment: this.standardLit.environmentFrame,
      ...(background === undefined ? {} : { background }),
      lightList,
      postColor: this.standardLit.postColor,
      deviceGeneration: this.options.graphics.device.generation,
      surfaceGeneration: this.options.graphics.surface.generation
    });
    camera.revision.release();
  }

  initializePreparation(): void {
    if (this.options.mesh === undefined || this.options.material === undefined) return;
    this.standardLit = new BaselineStandardLitPreparation({
      ...this.options,
      mesh: this.options.mesh,
      material: this.options.material
    });
  }

  frame(): BaselineRenderDiagnostics {
    this.assertLive();
    this.diagnostics =
      this.preparedSkip !== undefined
        ? Object.freeze({
            frame: this.diagnostics.frame + 1,
            viewId: this.options.viewId,
            status: 'skipped',
            reason: this.preparedSkip,
            deviceGeneration: this.options.graphics.device.generation,
            surfaceGeneration: this.options.graphics.surface.generation
          })
        : this.prepared === undefined
          ? Object.freeze({
              frame: this.diagnostics.frame + 1,
              viewId: this.options.viewId,
              status: 'skipped',
              reason: 'missing-resource',
              deviceGeneration: this.options.graphics.device.generation,
              surfaceGeneration: this.options.graphics.surface.generation
            })
          : this.renderer.frame(this.prepared);
    return this.diagnostics;
  }

  invalidate(): void {
    this.discardPrepared();
  }

  /** Replaces the active background without rebuilding the rendering pipeline. */
  updateBackground(bg: ViewBackground | undefined): void {
    this.backgroundOverride = bg;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.discardPrepared();
    this.meshExtraction?.dispose();
    this.lightExtraction?.dispose();
    this.cameraExtraction?.dispose();
    this.renderer.dispose();
    for (const res of [...this.standalonePostColorResources].reverse()) {
      res.dispose();
    }
    this.standalonePostColor = undefined;
    this.standalonePostColorResources = [];
    await this.standardLit?.dispose();
  }

  private initialize(world: World): void {
    if (this.renderWorld !== undefined) return;
    const plan = new RenderExtractorRegistryBuilder()
      .registerExtractor(MeshRenderExtractor)
      .registerExtractor(CameraRenderExtractor)
      .registerExtractor(DirectionalLightExtractor)
      .build();
    this.renderWorld = new RenderWorld({ extractorPlan: plan });
    this.meshExtraction = new MeshRenderExtraction(world, this.renderWorld);
    this.lightExtraction = new DirectionalLightExtraction(world, this.renderWorld);
    this.cameraExtraction = new CameraViewExtraction(world, this.renderWorld);
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Baseline rendering runtime has been disposed.');
  }

  private discardPrepared(): void {
    if (this.prepared?.status === 'ready') {
      for (const packet of this.prepared.packets) packet.release();
      this.prepared.lightList?.release();
      this.prepared.background?.release();
    }
    this.prepared = undefined;
    this.preparedSkip = undefined;
  }

  private matchesRegistration(
    revision: ReturnType<RenderWorld['snapshot']>,
    entity: import('../world').RenderEntityId
  ): boolean {
    const fields = revision.snapshot.get(entity);
    const mesh = fields?.get(MeshAssetField) as RenderMeshFact | undefined;
    const materials = fields?.get(MeshMaterialsField) as
      readonly RenderMaterialBinding[] | undefined;
    return (
      mesh !== undefined &&
      materials !== undefined &&
      this.options.mesh !== undefined &&
      this.options.material !== undefined &&
      mesh.handle.assetId === this.options.mesh.handle.assetId &&
      mesh.payloadVersion === this.options.mesh.payloadVersion &&
      materials.some(
        (binding) =>
          binding.handle.assetId === this.options.material!.handle.assetId &&
          binding.payloadVersion === this.options.material!.payloadVersion
      )
    );
  }
}

function collectTransforms(world: World): ReadonlyMap<Entity, RenderTransformFact> {
  return new Map(
    [...world.query([WorldTransform])].map(([entity, transform]) => [
      entity,
      {
        matrix: Array.from(transform.matrix),
        previousMatrix: Array.from(transform.previousMatrix),
        normalMatrix: Array.from(transform.normalMatrix),
        determinantSign: transform.determinantSign,
        worldVersion: transform.worldVersion
      }
    ])
  );
}
