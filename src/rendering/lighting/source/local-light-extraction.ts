import type { Entity } from '../../../ecs/types';
import type { World } from '../../../ecs/world';
import { RenderExtractorRegistryBuilder } from '../../world/extractor-registry';
import {
  defineExtractorToken,
  defineRenderField,
  type RenderEntityId,
  type RenderRevision,
  type RenderWorld
} from '../../world';
import { orderLightsForGpu } from '../core/light';
import type { PreparedLight } from '../types';
import { PointLightSource, SpotLightSource } from './local-light-source';

/** Immutable RenderWorld fact for either a point or spot light. */
export const LocalLightField = defineRenderField<PreparedLight>('light.local');
export const LocalLightExtractor = defineExtractorToken('local-light', [LocalLightField] as const);

/** Creates an extractor plan containing point and spot light publication. */
export function createLocalLightExtractorPlan() {
  return new RenderExtractorRegistryBuilder().registerExtractor(LocalLightExtractor).build();
}

/**
 * Publishes local-light facts with deterministic entity identity. Source scanning is intentionally
 * centralized here: it makes point/spot replacement atomic and prevents a frame from observing
 * an entity as both light kinds.
 */
export class LocalLightExtraction {
  private readonly active = new Map<Entity, RenderEntityId>();
  private previousExtractTick = 0;
  private disposed = false;

  constructor(
    private readonly main: World,
    private readonly render: RenderWorld
  ) {
    if (
      !main.isComponentRegistered(PointLightSource) ||
      !main.isComponentRegistered(SpotLightSource)
    ) {
      throw new Error(
        'Local-light extraction requires PointLightSource and SpotLightSource registration.'
      );
    }
  }

  extract(input: { readonly sourceTick: number }): RenderRevision {
    if (this.disposed) throw new Error('Cannot run a disposed local-light extraction adapter.');
    if (!Number.isSafeInteger(input.sourceTick) || input.sourceTick < this.previousExtractTick) {
      throw new Error('Local-light extraction source tick must be monotonic and non-negative.');
    }
    const tx = this.render.beginExtract(input.sourceTick, this.previousExtractTick);
    const next = new Map<Entity, RenderEntityId>();
    for (const [entity, source] of this.main.query([PointLightSource])) {
      const renderEntity = tx.mapEntity(entity);
      tx.draft(LocalLightExtractor).upsert(
        renderEntity,
        LocalLightField,
        Object.freeze({
          entity: renderEntity,
          payloadVersion: 1,
          kind: 'point',
          position: source.position,
          colorLinear: source.colorLinear,
          luminousIntensityCandela: source.luminousIntensityCandela,
          range: source.range,
          enabled: source.enabled,
          layerMask: source.layerMask,
          castsShadow: source.castsShadow
        }) as PreparedLight
      );
      next.set(entity, renderEntity);
    }
    for (const [entity, source] of this.main.query([SpotLightSource])) {
      if (next.has(entity))
        throw new Error('One entity cannot own both PointLightSource and SpotLightSource.');
      const renderEntity = tx.mapEntity(entity);
      tx.draft(LocalLightExtractor).upsert(
        renderEntity,
        LocalLightField,
        Object.freeze({
          entity: renderEntity,
          payloadVersion: 1,
          kind: 'spot',
          position: source.position,
          direction: source.direction,
          colorLinear: source.colorLinear,
          luminousIntensityCandela: source.luminousIntensityCandela,
          range: source.range,
          innerRadians: source.innerRadians,
          outerRadians: source.outerRadians,
          enabled: source.enabled,
          layerMask: source.layerMask,
          castsShadow: source.castsShadow
        }) as PreparedLight
      );
      next.set(entity, renderEntity);
    }
    for (const [entity, renderEntity] of this.active) {
      if (!next.has(entity))
        tx.removeEntity(renderEntity, this.main.isAlive(entity) ? 'extract-removed' : 'despawn');
    }
    const revision = tx.commit();
    this.active.clear();
    for (const entry of next) this.active.set(...entry);
    this.previousExtractTick = input.sourceTick;
    return revision;
  }

  lights(): readonly PreparedLight[] {
    return orderLightsForGpu(
      [...this.active.values()].map((entity) => this.render.read(entity, LocalLightField)!)
    );
  }

  dispose(): void {
    this.disposed = true;
    this.active.clear();
  }
}
