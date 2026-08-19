import { CommandBuffer } from '../command/command-buffer';
import type { ComponentType, Entity, Relation, RelationType } from '../types';
import type { World } from './world';

/**
 * Restricted World facade provided to reactive observers and sandboxed contexts.
 *
 * Exposes safe, read-only component and relationship queries against the live
 * ECS World while intercepting all structural mutations into a local CommandBuffer
 * to prevent reentrant state corruption during event dispatch or iteration.
 */
export class DeferredWorld {
  /**
   * Command buffer collecting all deferred structural changes (spawns, despawns,
   * component inserts/removals) for atomic playback after observer dispatch completes.
   */
  readonly commands = new CommandBuffer();

  /**
   * Constructs a new DeferredWorld wrapping the given live World instance.
   *
   * @param world - Live ECS World instance to proxy read queries to.
   */
  constructor(private readonly world: World) {}

  /**
   * Retrieves an immutable or typed view of a component attached to the entity.
   *
   * @param entity - Target entity handle.
   * @param component - Component schema descriptor.
   * @returns Component data view if attached, otherwise null.
   */
  getComponent<TView extends object>(
    entity: Entity,
    component: ComponentType<TView>
  ): TView | null {
    return this.world.getComponent(entity, component);
  }

  /**
   * Checks whether the entity has the specified component attached.
   *
   * @param entity - Target entity handle.
   * @param component - Component schema descriptor.
   * @returns True if the entity currently possesses the component.
   */
  hasComponent<TView extends object>(entity: Entity, component: ComponentType<TView>): boolean {
    return this.world.hasComponent(entity, component);
  }

  /**
   * Retrieves an indexed relationship instance attached to the entity.
   *
   * @param entity - Source entity handle.
   * @param relation - Relationship descriptor type.
   * @returns Relationship record if present, otherwise null.
   */
  getRelation(entity: Entity, relation: RelationType): Relation | null {
    return this.world.getRelation(entity, relation);
  }
}
