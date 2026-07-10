import type { ComponentType, Entity } from './types';

export class ChangeTracker {
  private readonly changed = new Map<string, Set<Entity>>();
  private readonly added = new Map<string, Set<Entity>>();
  private readonly removed = new Set<Entity>();

  markChanged(entity: Entity, componentId: string): void {
    getEntitySet(this.changed, componentId).add(entity);
  }

  markAdded(entity: Entity, componentId: string): void {
    getEntitySet(this.added, componentId).add(entity);
  }

  markRemoved(entity: Entity): void {
    this.removed.add(entity);
  }

  hasChanged(entity: Entity, componentTypes: readonly ComponentType<object>[]): boolean {
    return componentTypes.some((componentType) => this.changed.get(componentType.id)?.has(entity));
  }

  wasAdded(entity: Entity, componentTypes: readonly ComponentType<object>[]): boolean {
    return componentTypes.some((componentType) => this.added.get(componentType.id)?.has(entity));
  }

  wasRemoved(entity: Entity): boolean {
    return this.removed.has(entity);
  }

  clear(): void {
    for (const set of this.changed.values()) {
      set.clear();
    }
    for (const set of this.added.values()) {
      set.clear();
    }
    this.removed.clear();
  }
}

function getEntitySet(map: Map<string, Set<Entity>>, key: string): Set<Entity> {
  let set = map.get(key);
  if (!set) {
    set = new Set<Entity>();
    map.set(key, set);
  }
  return set;
}
