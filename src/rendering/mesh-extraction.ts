import type { ChangeReader } from '../ecs/change-tracker';
import type { Entity } from '../ecs/types';
import type { World } from '../ecs/world';
import type { MeshBounds } from '../geometry';
import { WorldTransform } from '../transform';
import { RenderExtractorRegistryBuilder } from './extractor-registry';
import { MeshRenderSource } from './mesh-render-source';
import {
  defineExtractorToken,
  defineRenderField,
  type RenderEntityId,
  type RenderRevision,
  type RenderWorld
} from './render-world';
import type {
  MeshExtractionInput,
  RenderMaterialBinding,
  RenderMeshFact,
  RenderTransformFact,
  RenderVisibilityFact
} from './types';

/** Current and previous model transforms in the active render reference frame. */
export const MeshTransformField = defineRenderField<RenderTransformFact>('mesh.transform');
/** Conservative object-local bounds copied from the validated mesh identity. */
export const MeshLocalBoundsField = defineRenderField<MeshBounds>('mesh.local-bounds');
/** Conservative world-space bounds derived during extraction. */
export const MeshWorldBoundsField = defineRenderField<MeshBounds>('mesh.world-bounds');
/** Versioned mesh asset and selected submesh identity. */
export const MeshAssetField = defineRenderField<RenderMeshFact>('mesh.asset');
/** Versioned material identities keyed by mesh material slot. */
export const MeshMaterialsField =
  defineRenderField<readonly RenderMaterialBinding[]>('mesh.materials');
/** MainWorld visibility intent and unsigned 32-bit render layer mask. */
export const MeshVisibilityField = defineRenderField<RenderVisibilityFact>('mesh.visibility');

/** Checked field ownership token for the standard mesh extractor. */
export const MeshRenderExtractor = defineExtractorToken('mesh-render', [
  MeshTransformField,
  MeshLocalBoundsField,
  MeshWorldBoundsField,
  MeshAssetField,
  MeshMaterialsField,
  MeshVisibilityField
] as const);

/** Creates the checked RenderWorld extractor plan for the standard mesh fact set. */
export function createMeshRenderExtractorPlan() {
  return new RenderExtractorRegistryBuilder().registerExtractor(MeshRenderExtractor).build();
}

/** Incrementally publishes render-ready MainWorld mesh facts as atomic RenderWorld revisions. */
export class MeshRenderExtraction {
  private readonly reader: ChangeReader;
  private readonly active = new Map<Entity, RenderEntityId>();
  private previousExtractTick = 0;
  private needsResync = true;
  private disposed = false;

  constructor(
    private readonly main: World,
    private readonly render: RenderWorld
  ) {
    if (
      !main.isComponentRegistered(MeshRenderSource) ||
      !main.isComponentRegistered(WorldTransform)
    ) {
      throw new Error(
        'Mesh extraction requires registered MeshRenderSource and WorldTransform components.'
      );
    }
    this.reader = main.createChangeReader({ from: 'beginning' });
  }

  extract(input: MeshExtractionInput): RenderRevision {
    if (this.disposed) throw new Error('Cannot run a disposed mesh extraction adapter.');
    requireTick(input.sourceTick);
    if (input.sourceTick < this.previousExtractTick) {
      throw new Error('Mesh extraction source tick must not move backwards.');
    }
    const tx = this.render.beginExtract(input.sourceTick, this.previousExtractTick);
    const nextActive = new Map(this.active);
    try {
      this.main.withChangeReader(this.reader, () => {
        const removed = new Set<Entity>([
          ...this.main.readRemoved(MeshRenderSource).map((entry) => entry.entity),
          ...this.main.readRemoved(WorldTransform).map((entry) => entry.entity)
        ]);
        const replacements = new Set<Entity>();
        for (const entity of removed) {
          if (
            this.main.isAlive(entity) &&
            this.main.hasComponent(entity, MeshRenderSource) &&
            this.main.hasComponent(entity, WorldTransform)
          ) {
            replacements.add(entity);
          } else {
            this.remove(tx, nextActive, entity);
          }
        }

        const desired = this.needsResync ? new Set<Entity>() : undefined;
        const filter = this.needsResync
          ? undefined
          : { changed: [MeshRenderSource, WorldTransform] as const };
        for (const [entity, source] of this.main.query(
          [MeshRenderSource, WorldTransform],
          filter
        )) {
          const transform = input.transforms.get(entity);
          if (transform === undefined) {
            throw new Error(
              `Mesh extraction is missing transform snapshot for entity "${entity}".`
            );
          }
          desired?.add(entity);
          this.write(tx, nextActive, entity, source, transform, replacements.has(entity));
        }
        if (desired !== undefined) {
          for (const entity of this.active.keys()) {
            if (!desired.has(entity)) this.remove(tx, nextActive, entity);
          }
        }
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.main.releaseChangeReader(this.reader);
  }

  private write(
    tx: ReturnType<RenderWorld['beginExtract']>,
    nextActive: Map<Entity, RenderEntityId>,
    entity: Entity,
    source: import('./types').MeshRenderSourceView,
    transform: RenderTransformFact,
    replace: boolean
  ): void {
    const renderEntity = replace
      ? tx.replaceEntity(entity, 'extract-removed')
      : tx.mapEntity(entity);
    const draft = tx.draft(MeshRenderExtractor);
    draft.upsert(renderEntity, MeshTransformField, transform);
    draft.upsert(renderEntity, MeshLocalBoundsField, source.localBounds);
    draft.upsert(
      renderEntity,
      MeshWorldBoundsField,
      transformBounds(source.localBounds, transform.matrix)
    );
    draft.upsert(renderEntity, MeshAssetField, { ...source.mesh, submesh: source.submesh });
    draft.upsert(renderEntity, MeshMaterialsField, source.materials);
    draft.upsert(renderEntity, MeshVisibilityField, {
      visible: source.visible,
      layerMask: source.layerMask
    });
    nextActive.set(entity, renderEntity);
  }

  private remove(
    tx: ReturnType<RenderWorld['beginExtract']>,
    nextActive: Map<Entity, RenderEntityId>,
    entity: Entity
  ): void {
    const renderEntity = nextActive.get(entity);
    if (renderEntity === undefined) return;
    tx.removeEntity(renderEntity, this.main.isAlive(entity) ? 'extract-removed' : 'despawn');
    nextActive.delete(entity);
  }
}

/** Transforms conservative local bounds into conservative world-space bounds. */
export function transformBounds(bounds: MeshBounds, matrix: readonly number[]): MeshBounds {
  if (matrix.length !== 16 || matrix.some((value) => !Number.isFinite(value))) {
    throw new Error('Mesh bounds transform must be a finite 4x4 matrix.');
  }
  const localCenter = bounds.aabb.min.map((value, axis) => (value + bounds.aabb.max[axis]!) / 2);
  const localExtent = bounds.aabb.min.map((value, axis) => (bounds.aabb.max[axis]! - value) / 2);
  const center = transformPoint(localCenter, matrix);
  const extent = [0, 1, 2].map(
    (row) =>
      Math.abs(matrix[row]!) * localExtent[0]! +
      Math.abs(matrix[4 + row]!) * localExtent[1]! +
      Math.abs(matrix[8 + row]!) * localExtent[2]!
  );
  const sphereCenter = transformPoint(bounds.sphere.center, matrix);
  const maxScale = Math.max(
    Math.hypot(matrix[0]!, matrix[1]!, matrix[2]!),
    Math.hypot(matrix[4]!, matrix[5]!, matrix[6]!),
    Math.hypot(matrix[8]!, matrix[9]!, matrix[10]!)
  );
  return {
    aabb: {
      min: [center[0]! - extent[0]!, center[1]! - extent[1]!, center[2]! - extent[2]!],
      max: [center[0]! + extent[0]!, center[1]! + extent[1]!, center[2]! + extent[2]!]
    },
    sphere: { center: sphereCenter, radius: bounds.sphere.radius * maxScale }
  };
}

function transformPoint(
  point: readonly number[],
  matrix: readonly number[]
): [number, number, number] {
  return [
    matrix[0]! * point[0]! + matrix[4]! * point[1]! + matrix[8]! * point[2]! + matrix[12]!,
    matrix[1]! * point[0]! + matrix[5]! * point[1]! + matrix[9]! * point[2]! + matrix[13]!,
    matrix[2]! * point[0]! + matrix[6]! * point[1]! + matrix[10]! * point[2]! + matrix[14]!
  ];
}

function requireTick(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Mesh extraction source tick must be a non-negative safe integer.');
  }
}
