import { ChangeTracker } from './change-tracker';
import { ChildOf, createComponentView, serializeComponent } from './component';
import { EntityAllocator } from './entity';
import { EntityBuilder } from './entity-builder';
import { QueryBuilder } from './query';
import { Table } from './table';
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
  private readonly relations = new Map<Entity, Map<symbol, Relation>>();

  spawn(): EntityBuilder {
    return new EntityBuilder(this, this.entityAllocator.allocate());
  }

  despawn(entity: Entity): boolean {
    if (!this.entityAllocator.isAlive(entity)) {
      return false;
    }

    const location = this.entityLocations.get(entity);
    if (location) {
      this.removeFromTable(entity, location);
    }

    this.relations.delete(entity);
    for (const entityRelations of this.relations.values()) {
      for (const [relationId, relation] of entityRelations) {
        if (relation.target === entity) {
          entityRelations.delete(relationId);
        }
      }
    }

    this.changeTracker.markRemoved(entity);
    return this.entityAllocator.free(entity);
  }

  isAlive(entity: Entity): boolean {
    return this.entityAllocator.isAlive(entity);
  }

  registerComponent<TView extends object>(schema: ComponentType<TView>): this {
    const existing = this.componentRegistry.get(schema.name);
    if (existing && existing !== schema) {
      throw new Error(`Component "${schema.name}" is already registered with a different schema.`);
    }

    this.componentRegistry.set(schema.name, schema as ComponentSchema<object>);
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
      const table = this.getOrCreateTable([schema]);
      const row = table.insert(entity, new Map([[schema.name, serialized]]));
      this.entityLocations.set(entity, { table, row });
      this.changeTracker.markAdded(entity, schema.name);
      this.changeTracker.markChanged(entity, schema.name);
      return this;
    }

    if (location.table.hasComponent(schema.name)) {
      location.table.writeComponent(schema, location.row, serialized);
      this.changeTracker.markChanged(entity, schema.name);
      return this;
    }

    this.migrateEntity(entity, location, schema, serialized);
    this.changeTracker.markAdded(entity, schema.name);
    this.changeTracker.markChanged(entity, schema.name);
    return this;
  }

  getComponent<TView extends object>(entity: Entity, componentType: ComponentType<TView>): TView | null {
    if (!this.entityAllocator.isAlive(entity)) {
      return null;
    }

    const schema = this.getRegisteredComponent(componentType);
    const location = this.entityLocations.get(entity);
    const column = location?.table.getColumnBuffer(schema.name);
    if (!location || !column) {
      return null;
    }

    return this.createView(schema, column, location.row, entity);
  }

  hasComponent<TView extends object>(entity: Entity, componentType: ComponentType<TView>): boolean {
    const schema = this.getRegisteredComponent(componentType);
    const location = this.entityLocations.get(entity);
    return location?.table.hasComponent(schema.name) === true;
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
    if (componentTypes.length === 0) {
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

        const views = schemas.map((schema) =>
          this.createView(schema, table.getRequiredColumn(schema.name), row, entity)
        );
        yield [entity, ...views] as unknown as QueryItem<TComponents>;
      }
    }
  }

  findMatchingTables(
    componentTypes: readonly ComponentSchema<object>[],
    filter: QueryFilter = {}
  ): Table[] {
    const requiredComponentNames = new Set(componentTypes.map((componentType) => componentType.name));
    for (const term of filter.with ?? []) {
      if (this.isComponentTerm(term)) {
        requiredComponentNames.add(term.name);
      }
    }

    const excludedComponentNames = new Set<string>();
    for (const term of filter.without ?? []) {
      if (this.isComponentTerm(term)) {
        excludedComponentNames.add(term.name);
      }
    }

    const matching: Table[] = [];
    for (const table of this.tables.values()) {
      let hasAll = true;
      for (const componentName of requiredComponentNames) {
        if (!table.hasComponent(componentName)) {
          hasAll = false;
          break;
        }
      }
      if (!hasAll) {
        continue;
      }

      let hasExcluded = false;
      for (const componentName of excludedComponentNames) {
        if (table.hasComponent(componentName)) {
          hasExcluded = true;
          break;
        }
      }
      if (!hasExcluded) {
        matching.push(table);
      }
    }

    return matching;
  }

  addRelation(entity: Entity, relation: RelationType, target: Entity): this {
    this.assertAlive(entity);
    this.assertAlive(target);

    let entityRelations = this.relations.get(entity);
    if (!entityRelations) {
      entityRelations = new Map<symbol, Relation>();
      this.relations.set(entity, entityRelations);
    }

    entityRelations.set(relation.id, { relation, target });
    return this;
  }

  removeRelation(entity: Entity, relation: RelationType): boolean {
    return this.relations.get(entity)?.delete(relation.id) ?? false;
  }

  getRelation(entity: Entity, relation: RelationType): Relation | null {
    return this.relations.get(entity)?.get(relation.id) ?? null;
  }

  getChildren(parent: Entity): Entity[] {
    const children: Entity[] = [];
    for (const entity of this.entityAllocator.aliveEntities()) {
      if (this.getRelation(entity, ChildOf)?.target === parent) {
        children.push(entity);
      }
    }
    return children;
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

  private createView<TView extends object>(
    schema: ComponentSchema<TView>,
    column: ArrayBuffer,
    row: number,
    entity: Entity
  ): TView {
    return createComponentView(schema, column, row, () => {
      this.changeTracker.markChanged(entity, schema.name);
    });
  }

  private entityMatchesFilter(entity: Entity, filter: QueryFilter, table?: Table): boolean {
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
      return table?.hasComponent(term.name) ?? this.hasComponent(entity, term);
    }
    return this.getRelation(entity, term) !== null;
  }

  private isComponentTerm(term: QueryFilterTerm): term is ComponentType<object> {
    return !isRelationTerm(term) && this.componentRegistry.has(term.name);
  }

  private assertAlive(entity: Entity): void {
    if (!this.entityAllocator.isAlive(entity)) {
      throw new Error(`Entity "${entity}" is not alive.`);
    }
  }

  private getRegisteredComponent<TView extends object>(
    schema: ComponentType<TView>
  ): ComponentSchema<TView> {
    const registered = this.componentRegistry.get(schema.name);
    if (!registered) {
      throw new Error(`Component "${schema.name}" has not been registered.`);
    }
    return registered as ComponentSchema<TView>;
  }

  private getOrCreateTable(componentTypes: readonly ComponentSchema<object>[]): Table {
    const sorted = [...componentTypes].sort((left, right) => left.name.localeCompare(right.name));
    const archetypeId = sorted.map((componentType) => componentType.name).join(',');
    let table = this.tables.get(archetypeId);
    if (!table) {
      table = new Table(sorted);
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
      oldComponents.set(schema.name, oldLocation.table.readComponent(schema, oldLocation.row));
    }
    oldComponents.set(newSchema.name, newData);

    const oldTypes = [...oldLocation.table.componentTypes];
    this.removeFromTable(entity, oldLocation);

    const newTable = this.getOrCreateTable([...oldTypes, newSchema]);
    const row = newTable.insert(entity, oldComponents);
    this.entityLocations.set(entity, { table: newTable, row });
  }

  private removeFromTable(entity: Entity, location: EntityLocation): void {
    const removal = location.table.remove(location.row);
    this.entityLocations.delete(entity);

    if (removal?.moved !== undefined) {
      this.entityLocations.set(removal.moved, { table: location.table, row: location.row });
    }
  }
}

function isRelationTerm(term: QueryFilterTerm): term is RelationType {
  return 'id' in term;
}
