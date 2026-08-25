import type { ChangeReader } from '../../ecs/change-tracker';
import type { Entity } from '../../ecs/types';
import type { World } from '../../ecs/world';
import { Mat4, REVERSE_DEPTH, STANDARD_DEPTH } from '../../math';
import { WorldTransform } from '../../transform';
import { createCpuVisibilityView } from '../visibility/visibility';
import { RenderExtractorRegistryBuilder } from '../world/extractor-registry';
import {
  defineExtractorToken,
  defineRenderField,
  type RenderEntityId,
  type RenderWorld
} from '../world';
import { MeshRenderExtractor } from '../mesh/mesh-extraction';
import { CameraRenderSource } from './camera-render-source';
import { extractView } from './camera';
import type {
  CameraExtractionInput,
  CameraExtractionResult,
  CameraRenderSourceView,
  CameraSurfaceViewBinding
} from './types';

/** MainWorld camera intent extracted for view composition and GPU state synthesis. */
export const CameraIntentField = defineRenderField<CameraRenderSourceView>('camera.intent');

/** Checked field ownership token for the standard camera extractor. */
export const CameraRenderExtractor = defineExtractorToken('camera-render', [
  CameraIntentField
] as const);

/** Builds a combined plan for both mesh and camera extraction passes. */
export function createStandardRenderExtractorPlan() {
  return new RenderExtractorRegistryBuilder()
    .registerExtractor(MeshRenderExtractor)
    .registerExtractor(CameraRenderExtractor)
    .build();
}

/** Publishes camera lifecycles and composes immutable per-surface ExtractedView snapshots. */
export class CameraViewExtraction {
  private readonly reader: ChangeReader;
  private readonly active = new Map<Entity, RenderEntityId>();
  private previousExtractTick = 0;
  private viewRevision = 0;
  private needsResync = true;
  private disposed = false;

  constructor(
    private readonly main: World,
    private readonly render: RenderWorld
  ) {
    if (
      !main.isComponentRegistered(CameraRenderSource) ||
      !main.isComponentRegistered(WorldTransform)
    ) {
      throw new Error(
        'Camera extraction requires CameraRenderSource and WorldTransform components.'
      );
    }
    this.reader = main.createChangeReader({ from: 'beginning' });
  }

  extract(input: CameraExtractionInput): CameraExtractionResult {
    if (this.disposed) throw new Error('Cannot run a disposed camera extraction adapter.');
    if (!Number.isSafeInteger(input.sourceTick) || input.sourceTick < this.previousExtractTick) {
      throw new Error('Camera extraction source tick must be monotonic and non-negative.');
    }
    assertBindings(input.bindings);
    const tx = this.render.beginExtract(input.sourceTick, this.previousExtractTick);
    const nextActive = new Map(this.active);
    try {
      this.main.withChangeReader(this.reader, () => {
        const removed = new Set([
          ...this.main.readRemoved(CameraRenderSource).map((entry) => entry.entity),
          ...this.main.readRemoved(WorldTransform).map((entry) => entry.entity)
        ]);
        const replacements = new Set<Entity>();
        for (const entity of removed) {
          if (this.eligible(entity)) replacements.add(entity);
          else this.remove(tx, nextActive, entity);
        }
        const desired = this.needsResync ? new Set<Entity>() : undefined;
        const filter = this.needsResync
          ? undefined
          : { changed: [CameraRenderSource, WorldTransform] as const };
        for (const [entity, intent] of this.main.query(
          [CameraRenderSource, WorldTransform],
          filter
        )) {
          desired?.add(entity);
          const renderEntity = replacements.has(entity)
            ? tx.replaceEntity(entity, 'extract-removed')
            : tx.mapEntity(entity);
          tx.draft(CameraRenderExtractor).upsert(renderEntity, CameraIntentField, intent);
          nextActive.set(entity, renderEntity);
        }
        if (desired)
          for (const entity of this.active.keys())
            if (!desired.has(entity)) this.remove(tx, nextActive, entity);
      });
      const nextViewRevision = this.viewRevision + 1;
      const views = input.bindings.map((binding) =>
        this.composeView(binding, input, nextActive, nextViewRevision)
      );
      const visibilityViews = views.map((view, index) => {
        const binding = input.bindings[index]!;
        const intent = this.main.getComponent(binding.camera, CameraRenderSource)!;
        return createCpuVisibilityView(view, {
          surface: binding.surface,
          featurePolicyKey: binding.featurePolicyKey,
          historyKey: intent.historyKey
        });
      });
      const revision = tx.commit();
      this.active.clear();
      for (const entry of nextActive) this.active.set(...entry);
      this.previousExtractTick = input.sourceTick;
      this.viewRevision = nextViewRevision;
      this.needsResync = false;
      return Object.freeze({
        revision,
        views: Object.freeze(views),
        visibilityViews: Object.freeze(visibilityViews)
      });
    } catch (error) {
      this.needsResync = true;
      throw error;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.main.releaseChangeReader(this.reader);
  }

  private composeView(
    binding: CameraSurfaceViewBinding,
    input: CameraExtractionInput,
    active: Map<Entity, RenderEntityId>,
    viewRevision: number
  ) {
    const camera = active.get(binding.camera);
    const intent = this.main.getComponent(binding.camera, CameraRenderSource);
    const transform = input.transforms.get(binding.camera);
    if (camera === undefined || intent === null || transform === undefined) {
      throw new Error(`Camera view "${binding.viewId}" references an ineligible camera.`);
    }
    const viewport = {
      logicalWidth: binding.logicalWidth,
      logicalHeight: binding.logicalHeight,
      devicePixelRatio: binding.devicePixelRatio,
      rect: intent.viewportRect
    };
    const pixels = binding.logicalWidth * binding.devicePixelRatio * intent.viewportRect.width;
    const height = binding.logicalHeight * binding.devicePixelRatio * intent.viewportRect.height;
    if (!(pixels > 0 && height > 0))
      throw new Error(`Camera view "${binding.viewId}" has a zero-sized viewport.`);
    const unjittered = binding.unjitteredProjection ?? projectionMatrix(intent, pixels / height);
    const projection = binding.projection ?? unjittered;
    return extractView({
      viewId: binding.viewId,
      camera,
      revision: viewRevision,
      view: Mat4.invert(transform.matrix),
      projection,
      ...(binding.unjitteredProjection === undefined
        ? {}
        : { unjitteredProjection: binding.unjitteredProjection }),
      projectionDescriptor: intent.projection,
      viewport,
      layerMask: intent.layerMask,
      jitterPixels: binding.jitterPixels ?? [0, 0],
      depthMode: intent.depthMode
    });
  }

  private eligible(entity: Entity): boolean {
    return (
      this.main.isAlive(entity) &&
      this.main.hasComponent(entity, CameraRenderSource) &&
      this.main.hasComponent(entity, WorldTransform)
    );
  }
  private remove(
    tx: ReturnType<RenderWorld['beginExtract']>,
    active: Map<Entity, RenderEntityId>,
    entity: Entity
  ): void {
    const renderEntity = active.get(entity);
    if (renderEntity === undefined) return;
    tx.removeEntity(renderEntity, this.main.isAlive(entity) ? 'extract-removed' : 'despawn');
    active.delete(entity);
  }
}

function projectionMatrix(intent: CameraRenderSourceView, aspect: number): Float32Array {
  const projection = intent.projection;
  if (projection.far === 'infinite')
    throw new Error(
      'Automatic infinite-far projection is not implemented; provide explicit projection matrices.'
    );
  if (projection.kind === 'perspective') {
    return Mat4.perspective(
      projection.verticalFovRadians!,
      aspect,
      projection.near,
      projection.far,
      intent.depthMode === 'standard' ? STANDARD_DEPTH : REVERSE_DEPTH
    );
  }
  const halfHeight = projection.orthographicHalfHeight!;
  const halfWidth = halfHeight * aspect;
  const near = projection.near,
    far = projection.far;
  const depthScale = intent.depthMode === 'standard' ? 1 / (near - far) : 1 / (far - near);
  const depthOffset = intent.depthMode === 'standard' ? near / (near - far) : far / (far - near);
  return new Float32Array([
    1 / halfWidth,
    0,
    0,
    0,
    0,
    1 / halfHeight,
    0,
    0,
    0,
    0,
    depthScale,
    0,
    0,
    0,
    depthOffset,
    1
  ]);
}

function assertBindings(bindings: readonly CameraSurfaceViewBinding[]): void {
  const ids = new Set<string>();
  for (const binding of bindings) {
    if (!binding.viewId.trim() || !binding.surface.trim() || !binding.featurePolicyKey.trim())
      throw new Error('Camera view binding identities must be non-empty.');
    if (ids.has(binding.viewId)) throw new Error(`Duplicate camera view ID "${binding.viewId}".`);
    ids.add(binding.viewId);
    if (
      binding.jitterPixels?.some((value) => value !== 0) &&
      (binding.projection === undefined || binding.unjitteredProjection === undefined)
    ) {
      throw new Error(
        'Jittered camera bindings must provide projection and unjitteredProjection matrices.'
      );
    }
  }
}
