import type { Entity, Relation } from '../types';
import { ChildOf } from './constants';

/**
 * Specialized fast lookup index for the hierarchical `ChildOf` relation.
 *
 * Maintains a parent-to-children multi-map (`parent -> Set<Entity>`) for O(1)
 * children resolution, while filtering dead entities at read time.
 */
export class ChildOfIndex {
  private readonly childrenByParent = new Map<Entity, Set<Entity>>();

  /**
   * Registers a child-parent relation edge in the index if it matches `ChildOf`.
   *
   * @param entity - The child entity.
   * @param relation - The relation instance.
   */
  add(entity: Entity, relation: Relation): void {
    if (relation.relation.id !== ChildOf.id) {
      return;
    }

    let children = this.childrenByParent.get(relation.target);
    if (!children) {
      children = new Set<Entity>();
      this.childrenByParent.set(relation.target, children);
    }
    children.add(entity);
  }

  /**
   * Removes a child-parent relation edge from the index if it matches `ChildOf`.
   *
   * @param entity - The child entity.
   * @param relation - The relation instance.
   */
  remove(entity: Entity, relation: Relation): void {
    if (relation.relation.id !== ChildOf.id) {
      return;
    }

    const children = this.childrenByParent.get(relation.target);
    children?.delete(entity);
    if (children?.size === 0) {
      this.childrenByParent.delete(relation.target);
    }
  }

  /**
   * Retrieves all live children for a given parent entity.
   *
   * @param parent - The parent entity whose children should be retrieved.
   * @param isAlive - Predicate to filter out despawned or dead entities at query time.
   * @returns An array of alive child entities.
   */
  getChildren(parent: Entity, isAlive: (entity: Entity) => boolean): Entity[] {
    // Filter liveness at read time so stale children from external lifecycle changes cannot leak.
    return [...(this.childrenByParent.get(parent) ?? [])].filter(isAlive);
  }

  /**
   * Clears all indexed parent-child relations.
   */
  clear(): void {
    this.childrenByParent.clear();
  }
}
