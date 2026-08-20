import { ChildOf } from '../ecs/component';
import { defineResource } from '../ecs/resource';
import type { Entity } from '../ecs/types';
import type { World } from '../ecs/world';
import { Mat4, Quat } from '../math';
import type { Quaternion, Vec3 } from '../math/types';
import { LocalTransform, WorldTransform } from './components';
import { markTransformHistory, TransformHistory, TransformHistoryResource } from './history';
import { TRANSFORM_EPSILON, TRANSFORM_OBSERVERS } from './constants';
import {
  updateWorldOrigin,
  worldPositionRelativeToOrigin,
  WorldOrigin,
  WorldOriginResource
} from './position';
import type {
  HistoryResetReason,
  LocalTransformInput,
  LocalTransformPatch,
  ParentDespawnPolicy,
  RenderTransformSnapshot,
  ReparentMode,
  TransformExtractOptions,
  TransformPropagationStats,
  TransformRuntimeOptions,
  WorldTransformView
} from './types';

const installed = new WeakMap<World, TransformRuntime>();

/**
 * Manages local-to-world transform hierarchy synchronization, floating origin rebasing,
 * and render matrix interpolation.
 */
export class TransformRuntime {
  private readonly dirty = new Set<Entity>();
  private readonly resetPrevious = new Set<Entity>();

  private constructor(
    private readonly world: World,
    readonly origin: WorldOrigin,
    readonly history: TransformHistory
  ) {
    world.addObserver({
      id: TRANSFORM_OBSERVERS.LocalAdded,
      event: 'component-added',
      component: LocalTransform,
      run: (event) => this.dirty.add(event.entity)
    });
    world.addObserver({
      id: TRANSFORM_OBSERVERS.ParentAdded,
      event: 'relation-added',
      relation: ChildOf,
      run: (event) => this.dirty.add(event.entity)
    });
    world.addObserver({
      id: TRANSFORM_OBSERVERS.ParentRemoved,
      event: 'relation-removed',
      relation: ChildOf,
      run: (event) => this.dirty.add(event.entity)
    });
  }

  /**
   * Installs and initializes the Transform subsystem resources and observers into the given ECS World.
   *
   * @param world The target ECS World.
   * @param options Configuration options including floating origin grid cell size.
   * @returns The active TransformRuntime instance.
   */
  static install(world: World, options: TransformRuntimeOptions = {}): TransformRuntime {
    const existing = installed.get(world);
    if (existing) {
      if (options.cellSize !== undefined && options.cellSize !== existing.origin.cellSize) {
        throw new Error('TransformRuntime is already installed with a different cellSize.');
      }
      return existing;
    }
    if (!world.isComponentRegistered(LocalTransform)) {
      world.registerComponent(LocalTransform);
    }
    if (!world.isComponentRegistered(WorldTransform)) {
      world.registerComponent(WorldTransform);
    }
    let origin = world.getResource(WorldOriginResource);
    if (!origin) {
      origin = new WorldOrigin(options.cellSize);
      world.insertResource(WorldOriginResource, origin);
    }
    if (options.cellSize !== undefined && origin.cellSize !== options.cellSize) {
      throw new Error('Existing WorldOrigin uses a different cellSize.');
    }
    let history = world.getResource(TransformHistoryResource);
    if (!history) {
      history = new TransformHistory();
      world.insertResource(TransformHistoryResource, history);
    }
    const runtime = new TransformRuntime(world, origin, history);
    world.insertResource(TransformRuntimeResource, runtime);
    installed.set(world, runtime);
    return runtime;
  }

  /**
   * Attaches LocalTransform (and WorldTransform if missing) components to an entity.
   *
   * @param entity Target entity ID.
   * @param input Initial TRS parameters.
   */
  attach(entity: Entity, input: LocalTransformInput = {}): void {
    const translation = input.translation ?? [0, 0, 0];
    const rotation = Quat.normalize(input.rotation ?? Quat.identity());
    const scale = input.scale ?? [1, 1, 1];
    assertFiniteVector('translation', translation);
    assertFiniteVector('scale', scale);
    this.world.insertComponent(entity, LocalTransform, {
      translation,
      rotation,
      scale,
      localVersion: 1
    });
    if (!this.world.hasComponent(entity, WorldTransform)) {
      const identity = Mat4.identity();
      this.world.insertComponent(entity, WorldTransform, {
        matrix: identity,
        previousMatrix: identity,
        normalMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
        worldVersion: 0,
        originCell: this.origin.cell,
        determinantSign: 1
      });
    }
    this.dirty.add(entity);
  }

  /**
   * Applies a partial update to an entity's local transform with change detection.
   *
   * @param entity Target entity ID.
   * @param patch TRS patch values.
   * @returns `true` if any component value changed beyond epsilon or `forceDirty` was set.
   */
  setLocal(entity: Entity, patch: LocalTransformPatch): boolean {
    const local = this.requireLocal(entity);
    const translation = patch.translation ?? tuple3(local.translation);
    const rotation = patch.rotation ? Quat.normalize(patch.rotation) : tuple4(local.rotation);
    const scale = patch.scale ?? tuple3(local.scale);
    assertFiniteVector('translation', translation);
    assertFiniteVector('scale', scale);
    const changed =
      patch.forceDirty === true ||
      !approximatelyEqual(local.translation, translation) ||
      !approximatelyEqual(local.rotation, rotation) ||
      !approximatelyEqual(local.scale, scale);
    if (!changed) {
      return false;
    }
    local.translation.set(translation);
    local.rotation.set(rotation);
    local.scale.set(scale);
    local.localVersion = (local.localVersion + 1) >>> 0;
    this.dirty.add(entity);
    return true;
  }

  /**
   * Teleports an entity locally and marks its previous matrix to be reset, preventing temporal interpolation trails.
   *
   * @param entity Target entity ID.
   * @param patch New TRS values.
   */
  teleport(entity: Entity, patch: LocalTransformPatch): void {
    this.setLocal(entity, { ...patch, forceDirty: true });
    this.resetPrevious.add(entity);
    markTransformHistory(this.history, 'teleport');
  }

  /**
   * Resets all entities' previous matrices to their current matrices to prevent frame interpolation artifacts.
   *
   * @param reason The discontinuity reason ('camera-cut' or 'scene-load').
   */
  resetHistory(reason: Exclude<HistoryResetReason, 'teleport' | 'origin-rebase'>): void {
    for (const [, derived] of this.world.query([WorldTransform])) {
      derived.previousMatrix.set(derived.matrix);
    }
    markTransformHistory(this.history, reason);
  }

  /**
   * Shifts the active world origin grid cell and offsets all root entities' translations accordingly.
   *
   * @param newCell Target integer cell coordinates [cx, cy, cz].
   * @returns `true` if the origin shifted, or `false` if the target cell matched the current origin.
   */
  rebase(newCell: Vec3): boolean {
    // Validate the new cell and full translation delta before changing any world state.
    const validated = new WorldOrigin(this.origin.cellSize, newCell).cell;
    const oldCell = this.origin.cell;
    if (approximatelyEqual(oldCell, validated)) {
      return false;
    }
    const delta: Vec3 = [
      (validated[0] - oldCell[0]) * this.origin.cellSize,
      (validated[1] - oldCell[1]) * this.origin.cellSize,
      (validated[2] - oldCell[2]) * this.origin.cellSize
    ];
    assertFiniteVector('origin rebase delta', delta);
    const entities = [...this.world.query([LocalTransform])].map(([entity]) => entity);
    const roots = entities.filter((entity) => this.world.getParent(entity) === null);

    updateWorldOrigin(this.origin, validated);
    for (const root of roots) {
      const local = this.requireLocal(root);
      this.setLocal(root, {
        translation: [
          local.translation[0]! - delta[0],
          local.translation[1]! - delta[1],
          local.translation[2]! - delta[2]
        ],
        forceDirty: true
      });
    }
    for (const entity of entities) {
      this.resetPrevious.add(entity);
    }
    markTransformHistory(this.history, 'origin-rebase');
    this.propagate();
    return true;
  }

  /**
   * Extracts interpolated, camera-relative render transform snapshots for all active WorldTransform entities.
   *
   * @param options Snapshot extraction parameters including interpolation alpha and camera position.
   * @returns Readonly map from Entity ID to RenderTransformSnapshot.
   */
  extract(options: TransformExtractOptions): ReadonlyMap<Entity, RenderTransformSnapshot> {
    const alpha = options.interpolationAlpha;
    if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) {
      throw new Error('Transform interpolationAlpha must be in the inclusive range [0, 1].');
    }
    const camera = options.camera
      ? worldPositionRelativeToOrigin(options.camera, this.origin)
      : ([0, 0, 0] as Vec3);
    const snapshots = new Map<Entity, RenderTransformSnapshot>();
    for (const [entity, derived] of this.world.query([WorldTransform])) {
      const matrix = interpolateTransform(derived.previousMatrix, derived.matrix, alpha);
      matrix[12] = matrix[12]! - camera[0];
      matrix[13] = matrix[13]! - camera[1];
      matrix[14] = matrix[14]! - camera[2];
      const previousMatrix = new Float32Array(derived.previousMatrix);
      previousMatrix[12] = previousMatrix[12]! - camera[0];
      previousMatrix[13] = previousMatrix[13]! - camera[1];
      previousMatrix[14] = previousMatrix[14]! - camera[2];
      snapshots.set(
        entity,
        Object.freeze({
          entity,
          matrix: snapshotMatrix(matrix),
          previousMatrix: snapshotMatrix(previousMatrix),
          normalMatrix: snapshotMatrix(safeNormalMatrix(matrix)),
          determinantSign: Math.sign(Mat4.determinant(matrix)),
          worldVersion: derived.worldVersion
        })
      );
    }
    return snapshots;
  }

  /**
   * Reparents an entity under a new parent or detaches it to the root level.
   *
   * @param entity Target entity ID.
   * @param parent New parent entity ID, or `null` to detach as root.
   * @param mode Reparenting mode: `'keep-local'` or `'keep-world'`.
   */
  reparent(entity: Entity, parent: Entity | null, mode: ReparentMode): void {
    this.requireLocal(entity);
    this.propagate();
    if (parent !== null) {
      this.requireLocal(parent);
      this.requireWorld(parent);
    }
    let keepWorldLocal:
      | { readonly translation: Vec3; readonly rotation: Quaternion; readonly scale: Vec3 }
      | undefined;
    if (mode === 'keep-world') {
      const currentWorld = this.requireWorld(entity);
      const parentMatrix = parent === null ? Mat4.identity() : this.requireWorld(parent).matrix;
      const localMatrix = Mat4.multiply(Mat4.invert(parentMatrix), currentWorld.matrix);
      keepWorldLocal = Mat4.decomposeTRS(localMatrix);
    }

    if (parent === null) {
      this.world.removeRelation(entity, ChildOf);
    } else {
      this.world.addRelation(entity, ChildOf, parent);
    }
    if (keepWorldLocal) {
      this.setLocal(entity, keepWorldLocal);
    } else {
      this.dirty.add(entity);
    }
  }

  /**
   * Despawns an entity according to the specified policy regarding its hierarchy children.
   *
   * @param entity Target entity ID.
   * @param policy Policy strategy: `'cascade'`, `'detach-keep-world'`, or `'reject-if-children'`.
   * @returns `true` if despawned successfully, `false` if entity was not alive.
   */
  despawn(entity: Entity, policy: ParentDespawnPolicy): boolean {
    if (!this.world.isAlive(entity)) {
      return false;
    }
    const children = this.world.getChildren(entity);
    if (policy === 'reject-if-children' && children.length > 0) {
      throw new Error(`Entity "${entity}" has children and cannot be despawned by this policy.`);
    }
    if (policy === 'detach-keep-world') {
      for (const child of children) {
        this.reparent(child, null, 'keep-world');
      }
      return this.world.despawn(entity);
    }
    if (policy === 'cascade') {
      const descendants: Entity[] = [];
      const stack = [entity];
      while (stack.length > 0) {
        const current = stack.pop()!;
        descendants.push(current);
        stack.push(...this.world.getChildren(current));
      }
      for (const descendant of descendants.reverse()) {
        this.world.despawn(descendant);
      }
      return true;
    }
    return this.world.despawn(entity);
  }

  /**
   * Evaluates all dirty local transforms and propagates updated world matrices down the hierarchy.
   *
   * @returns Propagation statistics including dirty roots count, total entities updated, and max depth.
   */
  propagate(): TransformPropagationStats {
    for (const [entity] of this.world.query([LocalTransform], {
      changed: [LocalTransform]
    })) {
      this.dirty.add(entity);
    }
    for (const entity of [...this.dirty]) {
      if (!this.world.isAlive(entity) || !this.world.hasComponent(entity, LocalTransform)) {
        this.dirty.delete(entity);
      }
    }
    const roots = [...this.dirty]
      .filter((entity) => !this.hasDirtyAncestor(entity))
      .sort((left, right) => left - right);
    let propagated = 0;
    let maxDepth = 0;
    for (const root of roots) {
      const parent = this.world.getParent(root);
      const parentMatrix =
        parent === null ? Mat4.identity() : new Float32Array(this.requireWorld(parent).matrix);
      const result = this.propagateSubtree(root, parentMatrix, 0);
      propagated += result.propagated;
      maxDepth = Math.max(maxDepth, result.maxDepth);
    }
    this.dirty.clear();
    return { dirtyRoots: roots.length, propagated, maxDepth };
  }

  private propagateSubtree(
    entity: Entity,
    parentMatrix: ArrayLike<number>,
    depth: number
  ): { readonly propagated: number; readonly maxDepth: number } {
    const stack: Array<{
      readonly entity: Entity;
      readonly parentMatrix: ArrayLike<number>;
      readonly depth: number;
    }> = [{ entity, parentMatrix, depth }];
    let propagated = 0;
    let maxDepth = depth;
    while (stack.length > 0) {
      const current = stack.pop()!;
      const local = this.world.getComponent(current.entity, LocalTransform);
      let worldMatrix: Float32Array<ArrayBufferLike> = new Float32Array(current.parentMatrix);
      if (local) {
        worldMatrix = Mat4.multiply(
          current.parentMatrix,
          Mat4.fromTRS(tuple3(local.translation), tuple4(local.rotation), tuple3(local.scale))
        );
        this.writeWorld(current.entity, worldMatrix);
        propagated++;
      }
      maxDepth = Math.max(maxDepth, current.depth);
      const children = this.world.getChildren(current.entity);
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push({
          entity: children[index]!,
          parentMatrix: worldMatrix,
          depth: current.depth + 1
        });
      }
    }
    return { propagated, maxDepth };
  }

  private writeWorld(entity: Entity, matrix: Float32Array): void {
    let world = this.world.getComponent(entity, WorldTransform);
    if (!world) {
      this.attachWorld(entity);
      world = this.requireWorld(entity);
    }
    if (approximatelyEqual(world.matrix, matrix) && !this.resetPrevious.has(entity)) {
      return;
    }
    const previous = new Float32Array(world.matrix);
    world.matrix.set(matrix);
    world.previousMatrix.set(this.resetPrevious.has(entity) ? matrix : previous);
    world.normalMatrix.set(safeNormalMatrix(matrix));
    world.determinantSign = Math.sign(Mat4.determinant(matrix));
    world.originCell.set(this.origin.cell);
    world.worldVersion = (world.worldVersion + 1) >>> 0;
    this.resetPrevious.delete(entity);
  }

  private attachWorld(entity: Entity): void {
    const identity = Mat4.identity();
    this.world.insertComponent(entity, WorldTransform, {
      matrix: identity,
      previousMatrix: identity,
      normalMatrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      worldVersion: 0,
      originCell: this.origin.cell,
      determinantSign: 1
    });
  }

  private hasDirtyAncestor(entity: Entity): boolean {
    let parent = this.world.getParent(entity);
    while (parent !== null) {
      if (this.dirty.has(parent)) {
        return true;
      }
      parent = this.world.getParent(parent);
    }
    return false;
  }

  private requireLocal(entity: Entity) {
    const local = this.world.getComponent(entity, LocalTransform);
    if (!local) {
      throw new Error(`Entity "${entity}" has no LocalTransform.`);
    }
    return local;
  }

  private requireWorld(entity: Entity): WorldTransformView {
    const world = this.world.getComponent(entity, WorldTransform);
    if (!world) {
      throw new Error(`Entity "${entity}" has no WorldTransform.`);
    }
    return world;
  }
}

function snapshotMatrix(matrix: ArrayLike<number>): readonly number[] {
  return Object.freeze(Array.from(matrix));
}

function interpolateTransform(
  previous: ArrayLike<number>,
  current: ArrayLike<number>,
  alpha: number
): Float32Array {
  try {
    const from = Mat4.decomposeTRS(previous);
    const to = Mat4.decomposeTRS(current);
    return Mat4.fromTRS(
      lerpVec3(from.translation, to.translation, alpha),
      Quat.slerp(from.rotation, to.rotation, alpha),
      lerpVec3(from.scale, to.scale, alpha)
    );
  } catch {
    // Singular/sheared extension matrices cannot use TRS interpolation safely.
    return new Float32Array(alpha < 1 ? previous : current);
  }
}

function lerpVec3(from: Vec3, to: Vec3, alpha: number): Vec3 {
  return [
    from[0] + (to[0] - from[0]) * alpha,
    from[1] + (to[1] - from[1]) * alpha,
    from[2] + (to[2] - from[2]) * alpha
  ];
}

function safeNormalMatrix(matrix: ArrayLike<number>): Float32Array {
  try {
    return Mat4.normalMatrix(matrix);
  } catch {
    return new Float32Array(9);
  }
}

function approximatelyEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index++) {
    if (Math.abs(left[index]! - right[index]!) > TRANSFORM_EPSILON) {
      return false;
    }
  }
  return true;
}

function assertFiniteVector(label: string, value: readonly number[]): void {
  if (!value.every(Number.isFinite)) {
    throw new Error(`${label} must contain only finite numbers.`);
  }
}

function tuple3(value: ArrayLike<number>): Vec3 {
  return [value[0]!, value[1]!, value[2]!];
}

function tuple4(value: ArrayLike<number>): Quaternion {
  return [value[0]!, value[1]!, value[2]!, value[3]!];
}

/**
 * ECS Resource token for accessing the active `TransformRuntime`.
 */
export const TransformRuntimeResource = defineResource<TransformRuntime>(
  'aether.transform.runtime'
);
