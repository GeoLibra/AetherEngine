import { isRecord } from '../../core';
import { defineObjectComponent } from '../../ecs/component';
import type { ChangeReader } from '../../ecs/change-tracker';
import type { Entity } from '../../ecs/types';
import type { World } from '../../ecs/world';
import { RenderExtractorRegistryBuilder } from '../world/extractor-registry';
import {
  defineExtractorToken,
  defineRenderField,
  type RenderEntityId,
  type RenderRevision,
  type RenderWorld
} from '../world';
import { normalizedLightDirection, orderLightsForGpu } from './light';
import type {
  DirectionalLightExtractionInput,
  DirectionalLightSourceView,
  PreparedLight
} from './types';

const UINT32_MAX = 0xffff_ffff;

/** MainWorld physical intent for a directional light whose direction is expressed in world space. */
export const DirectionalLightSource = defineObjectComponent<DirectionalLightSourceView>({
  id: 'aether.rendering.directional-light-source',
  version: 1,
  name: 'DirectionalLightSource',
  fields: [
    field('direction', { kind: 'vector', length: 3 }),
    field('colorLinear', { kind: 'vector', length: 3 }),
    field('illuminanceLux', { kind: 'number', format: 'f32' }),
    field('enabled', { kind: 'boolean' }),
    field('layerMask', { kind: 'number', format: 'u32' }),
    field('castsShadow', { kind: 'boolean' })
  ],
  validate(input) {
    if (!isRecord(input)) return invalid('DirectionalLightSource must be an object.');
    try {
      const direction = normalizedLightDirection(vector3(input.direction, 'direction'));
      const colorLinear = vector3(input.colorLinear, 'colorLinear');
      if (colorLinear.some((value) => value < 0)) {
        throw new Error('Directional light colorLinear must be non-negative.');
      }
      const illuminanceLux = nonNegativeFinite(input.illuminanceLux, 'illuminanceLux');
      if (typeof input.enabled !== 'boolean') throw new Error('enabled must be boolean.');
      const layerMask = uint32(input.layerMask, 'layerMask');
      if (typeof input.castsShadow !== 'boolean') throw new Error('castsShadow must be boolean.');
      return {
        ok: true,
        value: {
          direction,
          colorLinear,
          illuminanceLux,
          enabled: input.enabled,
          layerMask,
          castsShadow: input.castsShadow
        }
      };
    } catch (error) {
      return invalid(error instanceof Error ? error.message : 'Invalid DirectionalLightSource.');
    }
  }
});

/** Immutable prepared directional-light fact published to RenderWorld. */
export const DirectionalLightField = defineRenderField<PreparedLight>('light.directional');

/** Checked field owner for directional-light extraction. */
export const DirectionalLightExtractor = defineExtractorToken('directional-light', [
  DirectionalLightField
] as const);

/** Creates an extractor plan containing only the standard directional-light source. */
export function createDirectionalLightExtractorPlan() {
  return new RenderExtractorRegistryBuilder().registerExtractor(DirectionalLightExtractor).build();
}

/** Incrementally publishes validated directional lights and their removal tombstones. */
export class DirectionalLightExtraction {
  private readonly reader: ChangeReader;
  private readonly active = new Map<Entity, RenderEntityId>();
  private previousExtractTick = 0;
  private needsResync = true;
  private disposed = false;

  constructor(
    private readonly main: World,
    private readonly render: RenderWorld
  ) {
    if (!main.isComponentRegistered(DirectionalLightSource)) {
      throw new Error('Directional-light extraction requires DirectionalLightSource registration.');
    }
    this.reader = main.createChangeReader({ from: 'beginning' });
  }

  extract(input: DirectionalLightExtractionInput): RenderRevision {
    if (this.disposed)
      throw new Error('Cannot run a disposed directional-light extraction adapter.');
    if (!Number.isSafeInteger(input.sourceTick) || input.sourceTick < this.previousExtractTick) {
      throw new Error(
        'Directional-light extraction source tick must be monotonic and non-negative.'
      );
    }
    const tx = this.render.beginExtract(input.sourceTick, this.previousExtractTick);
    const nextActive = new Map(this.active);
    try {
      this.main.withChangeReader(this.reader, () => {
        const replacements = new Set<Entity>();
        for (const { entity } of this.main.readRemoved(DirectionalLightSource)) {
          if (this.main.isAlive(entity) && this.main.hasComponent(entity, DirectionalLightSource)) {
            replacements.add(entity);
          } else {
            this.remove(tx, nextActive, entity);
          }
        }
        const desired = this.needsResync ? new Set<Entity>() : undefined;
        const filter = this.needsResync
          ? undefined
          : { changed: [DirectionalLightSource] as const };
        for (const [entity, source] of this.main.query([DirectionalLightSource], filter)) {
          desired?.add(entity);
          const renderEntity = replacements.has(entity)
            ? tx.replaceEntity(entity, 'extract-removed')
            : tx.mapEntity(entity);
          tx.draft(DirectionalLightExtractor).upsert(
            renderEntity,
            DirectionalLightField,
            prepared(renderEntity, source)
          );
          nextActive.set(entity, renderEntity);
        }
        if (desired)
          for (const entity of this.active.keys())
            if (!desired.has(entity)) this.remove(tx, nextActive, entity);
      });
      const revision = tx.commit();
      this.active.clear();
      for (const entry of nextActive) this.active.set(...entry);
      this.previousExtractTick = input.sourceTick;
      this.needsResync = false;
      return revision;
    } catch (error) {
      this.needsResync = true;
      throw error;
    }
  }

  /** Returns the current light set ordered by stable RenderEntityId. */
  lights(): readonly PreparedLight[] {
    return orderLightsForGpu(
      [...this.active.values()].map((entity) => this.render.read(entity, DirectionalLightField)!)
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.main.releaseChangeReader(this.reader);
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

function prepared(entity: RenderEntityId, source: DirectionalLightSourceView): PreparedLight {
  return {
    entity,
    payloadVersion: 1,
    kind: 'directional',
    direction: source.direction,
    colorLinear: source.colorLinear,
    illuminanceLux: source.illuminanceLux,
    enabled: source.enabled,
    layerMask: source.layerMask,
    castsShadow: source.castsShadow
  };
}

function field(
  name: string,
  type: Parameters<typeof defineObjectComponent>[0]['fields'][number]['type']
) {
  return {
    id: name,
    name,
    type,
    required: true,
    compare: 'exact' as const,
    serialization: 'save' as const
  };
}

function vector3(value: unknown, label: string): readonly [number, number, number] {
  if (
    !Array.isArray(value) ||
    value.length !== 3 ||
    value.some((entry) => typeof entry !== 'number' || !Number.isFinite(entry))
  ) {
    throw new Error(`Directional light ${label} must contain three finite values.`);
  }
  return [value[0], value[1], value[2]];
}

function nonNegativeFinite(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`Directional light ${label} must be non-negative and finite.`);
  }
  return value;
}

function uint32(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > UINT32_MAX) {
    throw new Error(`Directional light ${label} must be an unsigned 32-bit integer.`);
  }
  return value as number;
}

function invalid(message: string) {
  return { ok: false as const, issues: [{ path: [], message }] };
}
