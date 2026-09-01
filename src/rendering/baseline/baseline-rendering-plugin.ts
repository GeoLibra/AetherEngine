import { definePlugin } from '../../app/utils';
import { MaterialAssetType, MeshAssetType, validateAssetHandle } from '../../assets';
import { defineResource } from '../../ecs/resource';
import type { Entity } from '../../ecs/types';
import type { World } from '../../ecs/world';
import { CameraRenderSource, CameraRenderExtractor, CameraViewExtraction } from '../camera';
import {
  DirectionalLightExtraction,
  DirectionalLightExtractor,
  DirectionalLightSource
} from '../lighting';
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
import { validateMeshData, type MeshBounds, type MeshData } from '../../geometry';
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

type NormalizedBaselineRenderingOptions = BaselineRenderingOptions &
  Readonly<{ viewId: string; featurePolicyKey: string }>;

/** Latest immutable baseline frame outcome published by the rendering plugin. */
export const BaselineRenderDiagnosticsResource = defineResource<BaselineRenderDiagnostics>(
  'aether.rendering.baseline.diagnostics'
);

/** Creates the opt-in owner for the single-view baseline rendering composition. */
export function createBaselineRenderingPlugin(options: BaselineRenderingOptions) {
  const validated = validateOptions(options);
  const runtime = new BaselineRenderingRuntime(validated);
  let unsubscribe: (() => boolean) | undefined;
  return definePlugin({
    id: 'aether.baseline-rendering',
    build(builder) {
      builder.insertResource(BaselineRenderDiagnosticsResource, runtime.diagnostics);
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
        writes: [BaselineRenderDiagnosticsResource],
        run(world) {
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
      unsubscribe?.();
      unsubscribe = undefined;
      return runtime.dispose();
    }
  });
}

class BaselineRenderingRuntime {
  private readonly renderer: BaselineRenderer;
  private renderWorld: RenderWorld | undefined;
  private meshExtraction: MeshRenderExtraction | undefined;
  private lightExtraction: DirectionalLightExtraction | undefined;
  private cameraExtraction: CameraViewExtraction | undefined;
  private standardLit: BaselineStandardLitPreparation | undefined;
  private prepared: BaselinePreparedFrame | undefined;
  private preparedSkip: BaselineRenderSkipReason | undefined;
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
              surface: this.options.viewId,
              logicalWidth: configuration.width,
              logicalHeight: configuration.height,
              devicePixelRatio: 1,
              featurePolicyKey: this.options.featurePolicyKey
            }
          ];
    const camera = this.cameraExtraction!.extract({ sourceTick, transforms, bindings });
    const view = camera.visibilityViews[0];
    this.discardPrepared();
    if (suspended) {
      this.preparedSkip = 'surface-suspended';
      this.prepared = undefined;
      camera.revision.release();
      return;
    }
    if (view === undefined || this.standardLit === undefined) {
      this.prepared = undefined;
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
    const light = this.lightExtraction!.lights().find(
      (candidate) => candidate.enabled && (candidate.layerMask & view.layerMask) !== 0
    );
    if (matching.length === 0 || light === undefined) {
      this.prepared = Object.freeze({
        status: 'missing',
        view,
        deviceGeneration: this.options.graphics.device.generation,
        surfaceGeneration: this.options.graphics.surface.generation
      });
      camera.revision.release();
      return;
    }
    const packets = matching.map((selected) => {
      const transform = camera.revision.snapshot
        .get(selected.renderEntity)
        ?.get(MeshTransformField) as RenderTransformFact | undefined;
      if (transform === undefined)
        throw new Error('Visible baseline mesh is missing its transform.');
      return this.standardLit!.createPacket({
        entity: selected.renderEntity,
        transform,
        view: camera.views[0]!,
        light
      });
    });
    this.prepared = Object.freeze({
      status: 'ready',
      view,
      packets: Object.freeze(packets),
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.discardPrepared();
    this.meshExtraction?.dispose();
    this.lightExtraction?.dispose();
    this.cameraExtraction?.dispose();
    this.renderer.dispose();
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

function validateOptions(options: BaselineRenderingOptions): NormalizedBaselineRenderingOptions {
  const viewId = options.viewId ?? 'main';
  const featurePolicyKey = options.featurePolicyKey ?? 'baseline';
  if (!viewId.trim()) throw new Error('Baseline rendering viewId must be non-empty.');
  if (!featurePolicyKey.trim()) {
    throw new Error('Baseline rendering featurePolicyKey must be non-empty.');
  }
  if ((options.mesh === undefined) !== (options.material === undefined)) {
    throw new Error(
      'Baseline rendering mesh and material registrations must be provided together.'
    );
  }
  const mesh =
    options.mesh === undefined
      ? undefined
      : Object.freeze({
          handle: validateAssetHandle(options.mesh.handle, MeshAssetType, 'Baseline mesh'),
          payloadVersion: payloadVersion(options.mesh.payloadVersion, 'mesh'),
          // Recompute bounds while taking ownership. Revalidating an already-derived floating
          // sphere as authored data can turn harmless rounding into a false containment failure.
          data: validateMeshData(meshInputWithoutBounds(options.mesh.data))
        });
  const material =
    options.material === undefined
      ? undefined
      : Object.freeze({
          handle: validateAssetHandle(
            options.material.handle,
            MaterialAssetType,
            'Baseline material'
          ),
          payloadVersion: payloadVersion(options.material.payloadVersion, 'material'),
          material: options.material.material
        });
  return Object.freeze({
    graphics: options.graphics,
    viewId,
    featurePolicyKey,
    ...(mesh === undefined ? {} : { mesh }),
    ...(material === undefined ? {} : { material })
  });
}

function meshInputWithoutBounds(data: MeshData) {
  const { bounds: _derivedBounds, ...input } = data;
  return input;
}

function payloadVersion(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Baseline rendering ${label} payloadVersion must be non-negative.`);
  }
  return value;
}

function assertGraphicsReady(graphics: BaselineRenderingOptions['graphics']): void {
  if (graphics.device.state !== 'live') {
    throw new Error('Baseline rendering startup requires a live graphics device.');
  }
  if (graphics.surface.state !== 'configured' || graphics.surface.configuration === undefined) {
    throw new Error('Baseline rendering startup requires a configured graphics surface.');
  }
}
