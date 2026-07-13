import { ChildOf } from './component';
import type { Entity, Relation, RelationType } from './types';

export class ChildOfIndex {
  private readonly childrenByParent = new Map<Entity, Set<Entity>>();

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

  getChildren(parent: Entity, isAlive: (entity: Entity) => boolean): Entity[] {
    // Filter liveness at read time so stale children from external lifecycle changes cannot leak.
    return [...(this.childrenByParent.get(parent) ?? [])].filter(isAlive);
  }

  clear(): void {
    this.childrenByParent.clear();
  }
}

export function createRelationAnyTag(relation: RelationType): string {
  // Matches "entity has this relation type", regardless of target.
  return `relation:${relation.key}`;
}

export function createRelationTargetTag(relation: RelationType, target: Entity): string {
  // Matches exact relation pairs, e.g. ChildOf(parent).
  return `relation:${relation.key}:target:${target}`;
}

export function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  // Used before archetype retagging to avoid unnecessary table migration.
  if (left.size !== right.size) {
    return false;
  }
  for (const value of left) {
    if (!right.has(value)) {
      return false;
    }
  }
  return true;
}
