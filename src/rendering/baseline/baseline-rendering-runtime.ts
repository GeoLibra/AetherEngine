import type { World } from '../../ecs/world';
import type { Entity } from '../../ecs/types';
import { CameraRenderSource, CameraRenderExtractor, CameraViewExtraction } from '../camera';
import {
  buildDirectionalShadowCascades,
  BuiltInFeature,
  DirectionalLightExtraction,
  DirectionalLightExtractor,
  DirectionalLightSource,
  shadowRequestKey
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
import { RenderExtractorRegistryBuilder, RenderWorld, type RenderEntityId } from '../world';
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
  createBaselineBackgroundFrame,
  type NormalizedBaselineRenderingOptions
} from './baseline-options';
import type { ViewBackground } from '../background/types';
import type {
  FeaturePolicyPublication,
  PreparedFeaturePolicy
} from '../../feature-policy/types';

const EMPTY_PACKETS = Object.freeze([]);

/**
 * Runtime coordinator managing per-frame extraction, preparation lifecycle,
 * and transactional FeaturePolicy reconfiguration for forward baseline rendering.
 */
export class BaselineRenderingRuntime {
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
  private currentPolicy: PreparedFeaturePolicy;
  private currentPolicyKey: string;
  private sourceTick = 0;
  private disposed = false;
  private readonly disposalErrors: unknown[] = [];
  private lastConsumedRevision: number;
  private pendingRetirementChain: Promise<void> = Promise.resolve();
  diagnostics: BaselineRenderDiagnostics;

  constructor(private readonly options: NormalizedBaselineRenderingOptions) {
    this.renderer = new BaselineRenderer(options);
    this.currentPolicy = options.featurePolicy;
    this.currentPolicyKey = options.featurePolicyKey;
    this.lastConsumedRevision = options.featurePolicy.snapshot.revision;
    this.diagnostics = Object.freeze({
      frame: 0, viewId: options.viewId, status: 'idle',
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
        : [{
            camera: cameras[0], viewId: this.options.viewId, surface: 'main',
            logicalWidth: configuration.width, logicalHeight: configuration.height,
            devicePixelRatio: 1, featurePolicyKey: this.currentPolicyKey
          }];
    const camera = this.cameraExtraction!.extract({ sourceTick, transforms, bindings });
    const view = camera.visibilityViews[0];
    if (suspended || view === undefined) {
      this.discardPrepared();
      this.preparedSkip = suspended ? 'surface-suspended' : undefined;
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
      return [{
        entity, layerMask: visibility.layerMask, enabled: visibility.visible,
        bounds: { kind: 'sphere' as const, ...bounds.sphere },
        boundsRevision: camera.revision.revision
      }];
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
      return Object.freeze({ renderEntity, layerMask: candidate.layerMask, enabled: candidate.enabled, bounds: candidate.bounds });
    });
    const lightList = this.standardLit.createLightListFrame({
      viewLayerMask: view.layerMask,
      lights,
      receivers
    });
    const shadowLight = lights.find(
      (candidate) => candidate.kind === 'directional' && candidate.castsShadow
    );
    const shadowDirection = shadowLight?.kind === 'directional' ? shadowLight.direction : undefined;
    const shadow =
      shadowLight === undefined || shadowDirection === undefined
        ? undefined
        : (() => {
            const cascades = buildDirectionalShadowCascades({
              inverseViewProjection: camera.views[0]!.inverseViewProjection,
              near: camera.views[0]!.near,
              far: camera.views[0]!.far,
              shadowDistance: camera.views[0]!.far === 'infinite' ? 100 : camera.views[0]!.far,
              lightDirection: shadowDirection,
              cascadeCount: 4,
              resolution: 1024
            });
            const requests = cascades.map((_, cascade) => Object.freeze({
              lightEntity: shadowLight.entity,
              viewId: view.id,
              kind: 'directional-cascade' as const,
              subresourceIndex: cascade,
              resolutionClass: 1024,
              importance: 1 - cascade / cascades.length,
              casterRevision: sourceTick
            }));
            const packetsByRequestKey = new Map(
              requests.map((request, cascade) => [
                shadowRequestKey(request),
                Object.freeze(
                  matching.map(({ renderEntity }) => {
                    const transform = camera.revision.snapshot
                      .get(renderEntity)
                      ?.get(MeshTransformField) as RenderTransformFact | undefined;
                    if (transform === undefined) {
                      throw new Error('Visible baseline shadow caster is missing its transform.');
                    }
                    return this.standardLit!.createShadowPacket({
                      entity: renderEntity,
                      transform,
                      viewProjection: cascades[cascade]!.viewProjection,
                      cascade
                    });
                  })
                )
              ])
            );
            const orderedLightIndex = [...lights]
              .sort((left, right) => left.entity - right.entity)
              .findIndex((candidate) => candidate.entity === shadowLight.entity);
            if (orderedLightIndex < 0) {
              throw new Error('Baseline shadow light is absent from the packed light list.');
            }
            return this.standardLit!.createDirectionalShadowFrame({
              requests: Object.freeze(requests),
              packetsByRequestKey,
              view: camera.views[0]!,
              cascades,
              lightIndex: orderedLightIndex
            });
          })();
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
      ...(shadow === undefined ? {} : { shadow }),
      shadowReceiver: this.standardLit.disabledShadowReceiver,
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
      material: this.options.material,
      featurePolicy: this.currentPolicy,
      featurePolicyKey: this.currentPolicyKey
    });
  }

  frame(): BaselineRenderDiagnostics {
    this.assertLive();
    const skipReason = this.preparedSkip ?? (this.prepared === undefined ? 'missing-resource' : undefined);
    this.diagnostics = skipReason !== undefined
      ? Object.freeze({
          frame: this.diagnostics.frame + 1, viewId: this.options.viewId,
          status: 'skipped', reason: skipReason,
          deviceGeneration: this.options.graphics.device.generation,
          surfaceGeneration: this.options.graphics.surface.generation
        })
      : this.renderer.frame(this.prepared!);
    return this.diagnostics;
  }

  invalidate(): void {
    this.discardPrepared();
  }

  /**
   * Transactionally updates the FeaturePolicy.
   *
   * Accepts either a full FeaturePolicyPublication or a PreparedFeaturePolicy.
   * Validates device generation fail-fast invariant.
   * Performs domain-specific invalidation (shader-pipeline hash and LightListBuild decision).
   * Constructs candidate preparation first; keeps current state intact if construction throws.
   * Releases retirement only after previous preparation's pending GPU submissions are terminal.
   */
  updateFeaturePolicy(
    publicationOrPolicy: FeaturePolicyPublication | PreparedFeaturePolicy
  ): void {
    const isPublication = 'current' in publicationOrPolicy;
    const nextPolicy = isPublication ? publicationOrPolicy.current : publicationOrPolicy;
    const publication = isPublication ? publicationOrPolicy : undefined;

    // Deduplicate repeat deliveries: if revision is already consumed and policy unchanged, no-op
    if (nextPolicy.snapshot.revision === this.lastConsumedRevision && nextPolicy === this.currentPolicy) {
      return;
    }

    // Fail-fast device generation invariant check
    if (nextPolicy.snapshot.deviceGeneration !== this.options.graphics.device.generation) {
      throw new Error(
        `FeaturePolicy deviceGeneration (${nextPolicy.snapshot.deviceGeneration}) does not match current device generation (${this.options.graphics.device.generation}).`
      );
    }

    const currentShaderKey =
      this.currentPolicy.snapshot.cacheDomainHashes.get('shader-pipeline') ??
      this.currentPolicy.snapshot.hash;
    const nextShaderKey =
      nextPolicy.snapshot.cacheDomainHashes.get('shader-pipeline') ?? nextPolicy.snapshot.hash;
    const currentLightListDecision =
      this.currentPolicy.snapshot.decisions.get(BuiltInFeature.LightListBuild)?.implementation;
    const nextLightListDecision =
      nextPolicy.snapshot.decisions.get(BuiltInFeature.LightListBuild)?.implementation;

    // Domain-specific invalidation: only recreate GPU resources if pipeline key or LightList decision changed
    const needsRebuild =
      currentShaderKey !== nextShaderKey || currentLightListDecision !== nextLightListDecision;

    const lease = publication?.retirement?.acquireLease();

    if (!needsRebuild) {
      this.currentPolicy = nextPolicy;
      this.currentPolicyKey = nextShaderKey;
      this.lastConsumedRevision = nextPolicy.snapshot.revision;
      if (lease !== undefined) {
        this.pendingRetirementChain = this.pendingRetirementChain.finally(() => lease.release());
      }
      return;
    }

    let candidate: BaselineStandardLitPreparation | undefined;
    if (this.options.mesh !== undefined && this.options.material !== undefined) {
      // Candidate-first transactional construction: if constructor throws, this.standardLit remains untouched
      try {
        candidate = new BaselineStandardLitPreparation({
          ...this.options,
          mesh: this.options.mesh,
          material: this.options.material,
          featurePolicy: nextPolicy,
          featurePolicyKey: nextShaderKey
        });
      } catch (error) {
        lease?.release();
        throw error;
      }
    }

    const oldPreparation = this.standardLit;
    this.standardLit = candidate;
    this.currentPolicy = nextPolicy;
    this.currentPolicyKey = nextShaderKey;
    this.lastConsumedRevision = nextPolicy.snapshot.revision;

    if (oldPreparation !== undefined) {
      const disposal = oldPreparation
        .dispose()
        .catch((err) => this.disposalErrors.push(err))
        .finally(() => lease?.release());
      this.pendingRetirementChain = this.pendingRetirementChain.finally(() => disposal);
    } else if (lease !== undefined) {
      this.pendingRetirementChain = this.pendingRetirementChain.finally(() => lease.release());
    }

    this.discardPrepared();
  }

  updateBackground(bg: ViewBackground | undefined): void {
    this.backgroundOverride = bg;
  }

  /** Dynamically updates the active environment intensity without rebuilding the rendering pipeline. */
  setEnvironmentIntensity(intensity: number): void {
    this.standardLit?.setEnvironmentIntensity(intensity);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.discardPrepared();
    this.meshExtraction?.dispose();
    this.lightExtraction?.dispose();
    this.cameraExtraction?.dispose();
    this.renderer.dispose();
    for (const res of [...this.standalonePostColorResources].reverse()) res.dispose();
    this.standalonePostColor = undefined;
    this.standalonePostColorResources = [];
    await this.standardLit?.dispose();
    await this.pendingRetirementChain;

    if (this.disposalErrors.length > 0) {
      throw new AggregateError(
        [...this.disposalErrors],
        'Baseline rendering runtime background disposal encountered errors.'
      );
    }
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
      if (this.prepared.shadow !== undefined) {
        for (const packets of this.prepared.shadow.packetsByRequestKey.values()) {
          for (const packet of packets) packet.release();
        }
      }
      this.prepared.lightList?.release();
      this.prepared.shadow?.release();
      this.prepared.background?.release();
    }
    this.prepared = undefined;
    this.preparedSkip = undefined;
  }

  private matchesRegistration(
    revision: ReturnType<RenderWorld['snapshot']>,
    entity: RenderEntityId
  ): boolean {
    const fields = revision.snapshot.get(entity);
    const mesh = fields?.get(MeshAssetField) as RenderMeshFact | undefined;
    const materials = fields?.get(MeshMaterialsField) as
      | readonly RenderMaterialBinding[]
      | undefined;
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
    [...world.query([WorldTransform])].map(([entity, t]) => [
      entity,
      {
        matrix: Array.from(t.matrix),
        previousMatrix: Array.from(t.previousMatrix),
        normalMatrix: Array.from(t.normalMatrix),
        determinantSign: t.determinantSign,
        worldVersion: t.worldVersion
      }
    ])
  );
}
