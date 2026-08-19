import type { ArchetypeCatalog } from './archetype-catalog';
import type { RelationIndex } from '../relation';
import { createRelationAnyTag, sameStringSet } from '../relation';
import type { Table } from './table';
import { createComponentTag } from './table-query';
import type { Entity, PackedComponentSchema } from '../types';

export interface EntityLocation {
  readonly table: Table;
  readonly row: number;
}

export function getTagTransitionOperation(
  previous: ReadonlySet<string>,
  next: ReadonlySet<string>
): `add:${string}` | `remove:${string}` {
  for (const tag of next) {
    if (!previous.has(tag)) {
      return `add:${tag}`;
    }
  }
  for (const tag of previous) {
    if (!next.has(tag)) {
      return `remove:${tag}`;
    }
  }
  throw new Error('Archetype tag transition requires a changed tag.');
}

export function getEntityTags(
  entity: Entity,
  objectComponents: ReadonlyMap<string, ReadonlyMap<Entity, object>>,
  tagComponents: ReadonlyMap<string, ReadonlySet<Entity>>,
  relationIndex: RelationIndex
): Set<string> {
  const tags = new Set<string>();
  for (const [componentId, storage] of objectComponents) {
    if (storage.has(entity)) {
      tags.add(createComponentTag(componentId));
    }
  }
  for (const [componentId, storage] of tagComponents) {
    if (storage.has(entity)) {
      tags.add(createComponentTag(componentId));
    }
  }
  for (const relation of relationIndex.outgoing(entity)) {
    // Exact targets remain indexed payloads and never fragment archetypes by target id.
    tags.add(createRelationAnyTag(relation.relation));
  }
  return tags;
}

export function readTableComponents(location: EntityLocation): Map<string, ArrayBuffer> {
  const components = new Map<string, ArrayBuffer>();
  for (const component of location.table.componentTypes) {
    components.set(component.id, location.table.readComponent(component, location.row));
  }
  return components;
}

export function removeFromTable(
  entity: Entity,
  location: EntityLocation,
  entityLocations: Map<Entity, EntityLocation>
): void {
  const removal = location.table.remove(location.row);
  entityLocations.delete(entity);

  if (removal?.moved !== undefined) {
    // Table removal is swap-remove; the moved entity inherits the removed row index.
    entityLocations.set(removal.moved, { table: location.table, row: location.row });
  }
}

export function restoreTableEntity(
  entity: Entity,
  table: Table,
  components: ReadonlyMap<string, ArrayBuffer>,
  entityLocations: Map<Entity, EntityLocation>
): void {
  const current = entityLocations.get(entity);
  if (current) {
    removeFromTable(entity, current, entityLocations);
  }
  const row = table.insert(entity, components);
  entityLocations.set(entity, { table, row });
}

export function migrateEntity(
  entity: Entity,
  oldLocation: EntityLocation,
  newSchema: PackedComponentSchema<object>,
  newData: ArrayBuffer,
  archetypes: ArchetypeCatalog,
  entityLocations: Map<Entity, EntityLocation>
): void {
  const oldComponents = new Map<string, ArrayBuffer>();
  for (const schema of oldLocation.table.componentTypes) {
    oldComponents.set(schema.id, oldLocation.table.readComponent(schema, oldLocation.row));
  }
  oldComponents.set(newSchema.id, newData);

  const oldTypes = [...oldLocation.table.componentTypes];
  const oldTags = oldLocation.table.tags;
  // Component insertion preserves existing relation tags while moving to a wider table.
  removeFromTable(entity, oldLocation, entityLocations);

  const newTable = archetypes.transition(
    oldLocation.table,
    `add:component:${newSchema.id}`,
    [...oldTypes, newSchema],
    oldTags
  );
  const row = newTable.insert(entity, oldComponents);
  entityLocations.set(entity, { table: newTable, row });
}

export function syncEntityArchetype(
  entity: Entity,
  entityLocations: Map<Entity, EntityLocation>,
  archetypes: ArchetypeCatalog,
  tags: ReadonlySet<string>
): void {
  const location = entityLocations.get(entity);

  if (!location) {
    // Relation-only entities still need a tag table so relation queries can find them.
    if (tags.size === 0) {
      return;
    }

    const table = archetypes.getOrCreate([], tags);
    const row = table.insert(entity, new Map());
    entityLocations.set(entity, { table, row });
    return;
  }

  if (sameStringSet(location.table.tags, tags)) {
    return;
  }

  const components = new Map<string, ArrayBuffer>();
  for (const schema of location.table.componentTypes) {
    components.set(schema.id, location.table.readComponent(schema, location.row));
  }
  const componentTypes = [...location.table.componentTypes];

  // Relation changes retag the archetype without altering component bytes.
  removeFromTable(entity, location, entityLocations);
  if (componentTypes.length === 0 && tags.size === 0) {
    return;
  }

  const operation = getTagTransitionOperation(location.table.tags, tags);
  const table = archetypes.transition(location.table, operation, componentTypes, tags);
  const row = table.insert(entity, components);
  entityLocations.set(entity, { table, row });
}
