import { ChangeTracker } from './change-tracker';
import { SchemaRegistry } from '../schema';
import { ChildOf, createComponentView, serializeComponent } from './component';
import { EntityAllocator } from './entity';
import { EntityBuilder } from './entity-builder';
import { QueryBuilder } from './query';
import {
  ChildOfIndex,
  createRelationAnyTag,
  createRelationTargetTag,
  sameStringSet
} from './relation';
import { createArchetypeId, Table } from './table';
import { findMatchingTables as findTablesMatchingQuery } from './table-query';
import type {
  ComponentInput,
  ComponentSchema,
  ComponentType,
  Entity,
  QueryFilter,
  QueryFilterTerm,
  QueryItem,
  Relation,
  RelationType,
  ResourceType
} from './types';

interface EntityLocation {
  readonly table: Table;
  readonly row: number;
}

/**
 * ECS storage environment holding entities, components, relationships, and resources.
 */
export class World {
  private readonly entityAllocator = new EntityAllocator();
  private readonly tables = new Map<string, Table>();
  private readonly entityLocations = new Map<Entity, EntityLocation>();
  private readonly componentRegistry = new Map<string, ComponentSchema<object>>();
  private readonly resources = new Map<ResourceType<unknown>, unknown>();
  private readonly changeTracker = new ChangeTracker();

  // Relation payloads live here for exact API lookups, while relation tags on tables make
  // relation queries participate in archetype matching.
  private readonly relations = new Map<Entity, Map<symbol, Relation>>();
  private readonly childOfIndex = new ChildOfIndex();

  constructor(schemaRegistry: SchemaRegistry = new SchemaRegistry()) {
    this.resources.set(SchemaRegistry, schemaRegistry);
  }

  spawn(): EntityBuilder {
    return new EntityBuilder(this, this.entityAllocator.allocate());
  }

  despawn(entity: Entity): boolean {
    if (!this.entityAllocator.isAlive(entity)) {
      return false;
    }

    // Remove outgoing relation indexes before deleting the source relation map.
    for (const relation of this.relations.get(entity)?.values() ?? []) {
      this.childOfIndex.remove(entity, relation);
    }

    this.relations.delete(entity);

    // Incoming relations must be removed through removeRelation() so their source entities
    // migrate out of relation-tagged archetypes as well.
    const relationsToRemove: Array<{ source: Entity; relation: RelationType }> = [];
    for (const [source, entityRelations] of this.relations) {
      for (const relation of entityRelations.values()) {
        if (relation.target === entity) {
          relationsToRemove.push({ source, relation: relation.relation });
        }
      }
    }
    for (const relationToRemove of relationsToRemove) {
      this.removeRelation(relationToRemove.source, relationToRemove.relation);
    }

    const location = this.entityLocations.get(entity);
    if (location) {
      this.removeFromTable(entity, location);
    }

    this.changeTracker.markRemoved(entity);
    return this.entityAllocator.free(entity);
  }

  isAlive(entity: Entity): boolean {
    return this.entityAllocator.isAlive(entity);
  }

  registerComponent<TView extends object>(schema: ComponentType<TView>): this {
    const existing = this.componentRegistry.get(schema.id);
    if (existing && existing !== schema) {
      throw new Error(`Component "${schema.id}" is already registered with a different schema.`);
    }
    if (existing === schema) {
      return this;
    }

    this.getSchemaRegistry().register(schema);
    this.componentRegistry.set(schema.id, schema as ComponentSchema<object>);
    return this;
  }

  insertComponent<TView extends object>(
    entity: Entity,
    componentType: ComponentType<TView>,
    data: ComponentInput = {}
  ): this {
    this.assertAlive(entity);
    const schema = this.getRegisteredComponent(componentType);
    const serialized = serializeComponent(schema, data);
    const location = this.entityLocations.get(entity);

    if (!location) {
      // Empty entities gain a table only once they receive components or relation tags.
      const table = this.getOrCreateTable([schema], this.getEntityTags(entity));
      const row = table.insert(entity, new Map([[schema.id, serialized]]));
      this.entityLocations.set(entity, { table, row });
      this.changeTracker.markAdded(entity, schema.id);
      this.changeTracker.markChanged(entity, schema.id);
      return this;
    }

    if (location.table.hasComponent(schema.id)) {
      location.table.writeComponent(schema, location.row, serialized);
      this.changeTracker.markChanged(entity, schema.id);
      return this;
    }

    this.migrateEntity(entity, location, schema, serialized);
    this.changeTracker.markAdded(entity, schema.id);
    this.changeTracker.markChanged(entity, schema.id);
    return this;
  }

  getComponent<TView extends object>(entity: Entity, componentType: ComponentType<TView>): TView | null {
    if (!this.entityAllocator.isAlive(entity)) {
      return null;
    }

    const schema = this.getRegisteredComponent(componentType);
    const location = this.entityLocations.get(entity);
    if (!location || !location.table.hasComponent(schema.id)) {
      return null;
    }

    return this.createView(schema, entity);
  }

  hasComponent<TView extends object>(entity: Entity, componentType: ComponentType<TView>): boolean {
    const schema = this.getRegisteredComponent(componentType);
    const location = this.entityLocations.get(entity);
    return location?.table.hasComponent(schema.id) === true;
  }

  query<const TComponents extends readonly ComponentType<object>[]>(
    componentTypes: TComponents,
    filter?: QueryFilter
  ): QueryBuilder<TComponents> {
    return new QueryBuilder(this, componentTypes).withFilter(filter);
  }

  *iterateQuery<const TComponents extends readonly ComponentType<object>[]>(
    componentTypes: TComponents,
    filter: QueryFilter
  ): Iterator<QueryItem<TComponents>> {
    if (componentTypes.length === 0 && !this.shouldUseTablesForEmptyQuery(filter)) {
      // Unfiltered entity-only queries must include totally empty entities, which have no table.
      for (const entity of this.entityAllocator.aliveEntities()) {
        if (this.entityMatchesFilter(entity, filter)) {
          yield [entity] as unknown as QueryItem<TComponents>;
        }
      }
      return;
    }

    const schemas = componentTypes.map((componentType) => this.getRegisteredComponent(componentType));
    for (const table of this.findMatchingTables(schemas, filter)) {
      for (let row = 0; row < table.length; row++) {
        const entity = table.getEntity(row);
        if (!this.entityMatchesFilter(entity, filter, table)) {
          continue;
        }

        const views = schemas.map((schema) => this.createView(schema, entity));
        yield [entity, ...views] as unknown as QueryItem<TComponents>;
      }
    }
  }

  findMatchingTables(
    componentTypes: readonly ComponentSchema<object>[],
    filter: QueryFilter = {}
  ): Table[] {
    // Kept public for tests and future query planning; the pure matcher owns the tag logic.
    return findTablesMatchingQuery(this.tables.values(), componentTypes, filter, (term) =>
      this.isComponentTerm(term)
    );
  }

  addRelation(entity: Entity, relation: RelationType, target: Entity): this {
    this.assertAlive(entity);
    this.assertAlive(target);

    let entityRelations = this.relations.get(entity);
    if (!entityRelations) {
      entityRelations = new Map<symbol, Relation>();
      this.relations.set(entity, entityRelations);
    }

    const previous = entityRelations.get(relation.id);
    if (previous) {
      this.childOfIndex.remove(entity, previous);
    }

    // A relation is both metadata and an archetype tag. Updating it may move the entity table.
    entityRelations.set(relation.id, { relation, target });
    this.childOfIndex.add(entity, { relation, target });
    this.syncEntityArchetype(entity);
    return this;
  }

  removeRelation(entity: Entity, relation: RelationType): boolean {
    const entityRelations = this.relations.get(entity);
    const existing = entityRelations?.get(relation.id);
    if (!entityRelations || !existing) {
      return false;
    }

    entityRelations.delete(relation.id);
    if (entityRelations.size === 0) {
      this.relations.delete(entity);
    }

    this.childOfIndex.remove(entity, existing);
    if (this.entityAllocator.isAlive(entity)) {
      this.syncEntityArchetype(entity);
    }
    return true;
  }

  getRelation(entity: Entity, relation: RelationType): Relation | null {
    return this.relations.get(entity)?.get(relation.id) ?? null;
  }

  getChildren(parent: Entity): Entity[] {
    return this.childOfIndex.getChildren(parent, (entity) => this.entityAllocator.isAlive(entity));
  }

  getParent(entity: Entity): Entity | null {
    return this.getRelation(entity, ChildOf)?.target ?? null;
  }

  traverseDescendants(root: Entity, callback: (entity: Entity, depth: number) => void): void {
    const visit = (entity: Entity, depth: number): void => {
      callback(entity, depth);
      for (const child of this.getChildren(entity)) {
        visit(child, depth + 1);
      }
    };

    visit(root, 0);
  }

  insertResource<T extends object>(resource: T): this {
    if (resource instanceof SchemaRegistry && resource !== this.getSchemaRegistry()) {
      throw new Error('World owns exactly one SchemaRegistry; it cannot be replaced.');
    }
    this.resources.set(resource.constructor as ResourceType<T>, resource);
    return this;
  }

  getResource<T>(type: ResourceType<T>): T | undefined {
    return this.resources.get(type) as T | undefined;
  }

  hasResource<T>(type: ResourceType<T>): boolean {
    return this.resources.has(type);
  }

  removeResource<T>(type: ResourceType<T>): T | undefined {
    if (type === (SchemaRegistry as unknown as ResourceType<T>)) {
      throw new Error('World SchemaRegistry cannot be removed.');
    }
    const resource = this.getResource(type);
    this.resources.delete(type);
    return resource;
  }

  hasChanged(entity: Entity, componentTypes: readonly ComponentType<object>[]): boolean {
    return this.changeTracker.hasChanged(entity, componentTypes);
  }

  clearTrackers(): void {
    this.changeTracker.clear();
  }

  shrinkTablesToFit(): void {
    for (const table of this.tables.values()) {
      table.shrinkToFit();
    }
  }

  private createView<TView extends object>(
    schema: ComponentSchema<TView>,
    entity: Entity
  ): TView {
    // The closure resolves current storage on every field access so old views remain valid
    // after table growth, component insertion, or relation retagging.
    return createComponentView(schema, () => this.getComponentStorage(entity, schema), () => {
      this.changeTracker.markChanged(entity, schema.id);
    });
  }

  private entityMatchesFilter(entity: Entity, filter: QueryFilter, table?: Table): boolean {
    // Table matching prunes most relation/component filters; this row-level pass handles
    // entity-specific relation payloads and frame-local change/added filters.
    if (filter.relation) {
      const [relation, target] = filter.relation;
      if (this.getRelation(entity, relation)?.target !== target) {
        return false;
      }
    }

    for (const term of filter.with ?? []) {
      if (!this.entityHasTerm(entity, term, table)) {
        return false;
      }
    }

    for (const term of filter.without ?? []) {
      if (this.entityHasTerm(entity, term, table)) {
        return false;
      }
    }

    if (filter.changed && !this.changeTracker.hasChanged(entity, filter.changed)) {
      return false;
    }

    if (filter.added && !this.changeTracker.wasAdded(entity, filter.added)) {
      return false;
    }

    return true;
  }

  private entityHasTerm(entity: Entity, term: QueryFilterTerm, table?: Table): boolean {
    if (!isRelationTerm(term)) {
      return table?.hasComponent(term.id) ?? this.hasComponent(entity, term);
    }
    return this.getRelation(entity, term) !== null;
  }

  private isComponentTerm(term: QueryFilterTerm): term is ComponentType<object> {
    return (
      !isRelationTerm(term) && this.componentRegistry.get(term.id) === term
    );
  }

  private assertAlive(entity: Entity): void {
    if (!this.entityAllocator.isAlive(entity)) {
      throw new Error(`Entity "${entity}" is not alive.`);
    }
  }

  private getRegisteredComponent<TView extends object>(
    schema: ComponentType<TView>
  ): ComponentSchema<TView> {
    const registered = this.componentRegistry.get(schema.id);
    if (!registered || registered !== schema) {
      throw new Error(`Component "${schema.id}" has not been registered.`);
    }
    return registered as ComponentSchema<TView>;
  }

  private getOrCreateTable(
    componentTypes: readonly ComponentSchema<object>[],
    tags: Iterable<string> = []
  ): Table {
    // Archetypes are keyed by component set plus relation tags. Tags have no column storage.
    const sorted = [...componentTypes].sort((left, right) => left.id.localeCompare(right.id));
    const tagList = [...tags].sort();
    const archetypeId = createArchetypeId(sorted, tagList);
    let table = this.tables.get(archetypeId);
    if (!table) {
      table = new Table(sorted, tagList);
      this.tables.set(archetypeId, table);
    }
    return table;
  }

  private migrateEntity(
    entity: Entity,
    oldLocation: EntityLocation,
    newSchema: ComponentSchema<object>,
    newData: ArrayBuffer
  ): void {
    const oldComponents = new Map<string, ArrayBuffer>();
    for (const schema of oldLocation.table.componentTypes) {
      oldComponents.set(schema.id, oldLocation.table.readComponent(schema, oldLocation.row));
    }
    oldComponents.set(newSchema.id, newData);

    const oldTypes = [...oldLocation.table.componentTypes];
    const oldTags = oldLocation.table.tags;
    // Component insertion preserves existing relation tags while moving to a wider table.
    this.removeFromTable(entity, oldLocation);

    const newTable = this.getOrCreateTable([...oldTypes, newSchema], oldTags);
    const row = newTable.insert(entity, oldComponents);
    this.entityLocations.set(entity, { table: newTable, row });
  }

  private syncEntityArchetype(entity: Entity): void {
    const tags = this.getEntityTags(entity);
    const location = this.entityLocations.get(entity);

    if (!location) {
      // Relation-only entities still need a tag table so relation queries can find them.
      if (tags.size === 0) {
        return;
      }

      const table = this.getOrCreateTable([], tags);
      const row = table.insert(entity, new Map());
      this.entityLocations.set(entity, { table, row });
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
    this.removeFromTable(entity, location);
    if (componentTypes.length === 0 && tags.size === 0) {
      return;
    }

    const table = this.getOrCreateTable(componentTypes, tags);
    const row = table.insert(entity, components);
    this.entityLocations.set(entity, { table, row });
  }

  private getComponentStorage<TView extends object>(
    entity: Entity,
    schema: ComponentSchema<TView>
  ): { readonly buffer: ArrayBuffer; readonly row: number } {
    const location = this.entityLocations.get(entity);
    if (!location || !location.table.hasComponent(schema.id)) {
      throw new Error(`Entity "${entity}" does not have component "${schema.name}".`);
    }

    return {
      ...location.table.getComponentStorage(schema.id, location.row)
    };
  }

  private getSchemaRegistry(): SchemaRegistry {
    return this.resources.get(SchemaRegistry) as SchemaRegistry;
  }

  private getEntityTags(entity: Entity): Set<string> {
    const tags = new Set<string>();
    for (const relation of this.relations.get(entity)?.values() ?? []) {
      // Store both "has relation type" and "has relation-to-target" tags.
      tags.add(createRelationAnyTag(relation.relation));
      tags.add(createRelationTargetTag(relation.relation, relation.target));
    }
    return tags;
  }

  private shouldUseTablesForEmptyQuery(filter: QueryFilter): boolean {
    // Relation filters are encoded in tables, so even an entity-only relation query should
    // iterate matching tables instead of every alive entity.
    return Boolean(filter.relation || (filter.with?.length ?? 0) > 0);
  }

  private removeFromTable(entity: Entity, location: EntityLocation): void {
    const removal = location.table.remove(location.row);
    this.entityLocations.delete(entity);

    if (removal?.moved !== undefined) {
      // Table removal is swap-remove; the moved entity inherits the removed row index.
      this.entityLocations.set(removal.moved, { table: location.table, row: location.row });
    }
  }
}

function isRelationTerm(term: QueryFilterTerm): term is RelationType {
  return typeof term.id === 'symbol';
}
