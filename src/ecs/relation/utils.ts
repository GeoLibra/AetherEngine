import type { Entity, Relation, RelationType } from '../types';

/**
 * Creates an archetype table tag matching any entity possessing this relation type, regardless of target.
 *
 * @param relation - The relation type descriptor.
 * @returns Archetype tag string in the format `relation:<relation.key>`.
 */
export function createRelationAnyTag(relation: RelationType): string {
  // Matches "entity has this relation type", regardless of target.
  return `relation:${relation.key}`;
}

/**
 * Creates an archetype table tag matching an exact relation pair (e.g. `ChildOf(parent)`).
 *
 * @param relation - The relation type descriptor.
 * @param target - The specific target entity.
 * @returns Archetype tag string in the format `relation:<relation.key>:target:<target>`.
 */
export function createRelationTargetTag(relation: RelationType, target: Entity): string {
  // Matches exact relation pairs, e.g. ChildOf(parent).
  return `relation:${relation.key}:target:${target}`;
}

/**
 * Compares two string sets for exact equality (same size and elements).
 *
 * Used before archetype retagging to avoid unnecessary table migration.
 *
 * @param left - First set to compare.
 * @param right - Second set to compare.
 * @returns `true` if both sets contain the exact same strings, `false` otherwise.
 */
export function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
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

/**
 * Checks whether establishing a relation from `source` to `target` would introduce a directed cycle.
 *
 * @param source - The prospective source entity.
 * @param relation - The acyclic relation type being checked.
 * @param target - The prospective target entity.
 * @param getRelation - Function to look up an active outgoing relation on an entity.
 * @returns `true` if adding the edge would create a cycle, `false` otherwise.
 */
export function wouldCreateRelationCycle(
  source: Entity,
  relation: RelationType,
  target: Entity,
  getRelation: (entity: Entity, relation: RelationType) => Relation | null
): boolean {
  const visited = new Set<Entity>();
  let current: Entity | null = target;
  while (current !== null) {
    if (current === source || visited.has(current)) {
      return true;
    }
    visited.add(current);
    current = getRelation(current, relation)?.target ?? null;
  }
  return false;
}

/**
 * Traverses an entity hierarchy recursively starting from `root` in depth-first order.
 *
 * @param root - The starting root entity.
 * @param getChildren - Callback to resolve immediate children of an entity.
 * @param callback - Visitor invoked for each entity and its current depth.
 */
export function traverseDescendants(
  root: Entity,
  getChildren: (parent: Entity) => Entity[],
  callback: (entity: Entity, depth: number) => void
): void {
  const visit = (entity: Entity, depth: number): void => {
    callback(entity, depth);
    for (const child of getChildren(entity)) {
      visit(child, depth + 1);
    }
  };

  visit(root, 0);
}

/**
 * Helper to retrieve or create a Set in a Map.
 *
 * @internal
 */
export function getOrCreateSet<K, V>(map: Map<K, Set<V>>, key: K): Set<V> {
  let values = map.get(key);
  if (!values) {
    values = new Set();
    map.set(key, values);
  }
  return values;
}

/**
 * Helper to retrieve or create a nested Set in a two-level Map.
 *
 * @internal
 */
export function getOrCreateNestedSet<Outer, Inner, V>(
  map: Map<Outer, Map<Inner, Set<V>>>,
  outer: Outer,
  inner: Inner
): Set<V> {
  let nested = map.get(outer);
  if (!nested) {
    nested = new Map();
    map.set(outer, nested);
  }
  return getOrCreateSet(nested, inner);
}

/**
 * Helper to delete an element from a Set in a Map, pruning empty Sets.
 *
 * @internal
 */
export function deleteFromSet<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const values = map.get(key);
  values?.delete(value);
  if (values?.size === 0) {
    map.delete(key);
  }
}

/**
 * Helper to delete an element from a nested Set in a two-level Map, pruning empty Sets and Maps.
 *
 * @internal
 */
export function deleteFromNestedSet<Outer, Inner, V>(
  map: Map<Outer, Map<Inner, Set<V>>>,
  outer: Outer,
  inner: Inner,
  value: V
): void {
  const nested = map.get(outer);
  const values = nested?.get(inner);
  values?.delete(value);
  if (values?.size === 0) {
    nested?.delete(inner);
  }
  if (nested?.size === 0) {
    map.delete(outer);
  }
}
