import { ChangeReader, ChangeTracker } from './change-tracker';
import { CommandBuffer, CommandBufferResource } from './command-buffer';
import { EventRegistry, EventRegistryResource } from '../events/event-registry';
import { StateRegistry, StateRegistryResource } from '../events/state-registry';
import { DiagnosticStore, DiagnosticStoreResource } from '../diagnostics/store';
import { SchemaRegistry, SchemaRegistryResource } from '../schema';
import {
  ChildOf,
  createComponentView,
  createObjectComponentValue,
  serializeComponent,
  validateComponentInput
} from './component';
import { createWorldId, decodeEntity, EntityAllocator } from './entity';
import { ResourceStore } from './resource';
import { EntityBuilder } from './entity-builder';
import { QueryBuilder } from './query';
import { ObserverRegistry } from './observer';
import type {
  ObserverDescriptor,
  ObserverEvent,
  ObserverRegistration
} from './observer';
import {
  ChildOfIndex,
  createRelationAnyTag,
  sameStringSet
} from './relation';
import { createArchetypeId, Table } from './table';
import {
  createComponentTag,
  findMatchingTables as findTablesMatchingQuery
} from './table-query';
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
  ResourceToken,
  ChangeReaderOptions,
  RemovedComponent,
  ChangeWindow,
  ObjectComponentSchema,
  PackedComponentSchema,
  TagComponentSchema,
  WorldId
} from './types';

interface EntityLocation {
  readonly table: Table;
  readonly row: number;
}

/**
 * ECS storage environment holding entities, components, relationships, and resources.
 */
export class World {
  readonly id: WorldId;
  private readonly entityAllocator: EntityAllocator;
  private readonly tables = new Map<string, Table>();
  private readonly entityLocations = new Map<Entity, EntityLocation>();
  private readonly componentRegistry = new Map<string, ComponentType<object>>();
  private readonly objectComponents = new Map<string, Map<Entity, object>>();
  private readonly tagComponents = new Map<string, Set<Entity>>();
  private readonly tagViews = new Map<string, object>();
  private readonly resources = new ResourceStore();
  private readonly changeTracker = new ChangeTracker();
  private readonly systemChangeReaders = new Map<string, ChangeReader>();
  private activeChangeWindow: ChangeWindow | undefined;

  // Relation payloads and exact targets live here; tables contain relation-type tags only.
  private readonly relations = new Map<Entity, Map<symbol, Relation>>();
  private readonly childOfIndex = new ChildOfIndex();
  private readonly observerRegistry = new ObserverRegistry();
  private activeQueryIterations = 0;
  private observerDispatchDepth = 0;

  constructor(schemaRegistry: SchemaRegistry = new SchemaRegistry()) {
    this.id = createWorldId();
    this.entityAllocator = new EntityAllocator(this.id);
    this.resources.insert(SchemaRegistryResource, schemaRegistry, true);
    this.resources.insert(CommandBufferResource, new CommandBuffer(), true);
    this.resources.insert(EventRegistryResource, new EventRegistry(), true);
    this.resources.insert(StateRegistryResource, new StateRegistry(), true);
    this.resources.insert(DiagnosticStoreResource, new DiagnosticStore(), true);
  }

  spawn(): EntityBuilder {
    this.assertStructuralMutationAllowed();
    return new EntityBuilder(this, this.entityAllocator.allocate());
  }

  despawn(entity: Entity): boolean {
    this.assertStructuralMutationAllowed();
    this.assertOwned(entity);
    if (!this.entityAllocator.isAlive(entity)) {
      return false;
    }

    const entityComponentTypes = this.getEntityComponentTypes(entity);
    const outgoingRelations = [...(this.relations.get(entity)?.values() ?? [])];
    const incomingRelations: Array<{ readonly source: Entity; readonly value: Relation }> = [];
    for (const [source, entityRelations] of this.relations) {
      if (source === entity) {
        continue;
      }
      for (const value of entityRelations.values()) {
        if (value.target === entity) {
          incomingRelations.push({ source, value });
        }
      }
    }
    const deferred = this.dispatchObservers([
      ...entityComponentTypes.map(
        (component): ObserverEvent => ({
          kind: 'component-removed',
          entity,
          component
        })
      ),
      ...outgoingRelations.map(
        (value): ObserverEvent => ({
          kind: 'relation-removed',
          entity,
          relation: value.relation,
          target: value.target
        })
      ),
      ...incomingRelations.map(
        ({ source, value }): ObserverEvent => ({
          kind: 'relation-removed',
          entity: source,
          relation: value.relation,
          target: value.target
        })
      ),
      { kind: 'entity-despawned', entity }
    ]);

    // Remove outgoing relation indexes before deleting the source relation map.
    for (const relation of outgoingRelations) {
      this.childOfIndex.remove(entity, relation);
    }

    this.relations.delete(entity);
    for (const storage of this.objectComponents.values()) {
      storage.delete(entity);
    }
    for (const storage of this.tagComponents.values()) {
      storage.delete(entity);
    }

    // Observer validation already succeeded for the full despawn mutation. Remove incoming
    // edges without redispatching so one failing observer cannot leave a half-detached graph.
    for (const { source, value } of incomingRelations) {
      const sourceRelations = this.relations.get(source);
      sourceRelations?.delete(value.relation.id);
      if (sourceRelations?.size === 0) {
        this.relations.delete(source);
      }
      this.childOfIndex.remove(source, value);
      this.syncEntityArchetype(source);
    }

    const location = this.entityLocations.get(entity);
    if (location) {
      this.removeFromTable(entity, location);
    }

    this.changeTracker.markRemoved(
      entity,
      entityComponentTypes.map((component) => component.id)
    );
    const removed = this.entityAllocator.free(entity);
    this.enqueueObserverCommands(deferred);
    return removed;
  }

  isAlive(entity: Entity): boolean {
    this.assertOwned(entity);
    return this.entityAllocator.isAlive(entity);
  }

  registerComponent<TView extends object>(schema: ComponentType<TView>): this {
    this.assertStructuralMutationAllowed();
    const existing = this.componentRegistry.get(schema.id);
    if (existing && existing !== schema) {
      throw new Error(`Component "${schema.id}" is already registered with a different schema.`);
    }
    if (existing === schema) {
      return this;
    }

    this.getSchemaRegistry().register(schema);
    this.componentRegistry.set(schema.id, schema as ComponentType<object>);
    return this;
  }

  insertComponent<TView extends object>(
    entity: Entity,
    componentType: ComponentType<TView>,
    data: ComponentInput = {}
  ): this {
    this.assertStructuralMutationAllowed();
    this.assertAlive(entity);
    const schema = this.getRegisteredComponent(componentType);
    this.assertOwnedEntityReferences(schema, data);
    validateComponentInput(schema as ComponentType<object>, data);
    if (schema.storage === 'object') {
      this.insertObjectComponent(entity, schema, data);
      return this;
    }
    if (schema.storage === 'tag') {
      this.insertTagComponent(entity, schema);
      return this;
    }
    const serialized = serializeComponent(schema, data);
    const location = this.entityLocations.get(entity);
    const isAdded = !location?.table.hasComponent(schema.id);
    const deferred = isAdded
      ? this.dispatchObservers([
          {
            kind: 'component-added',
            entity,
            component: schema as ComponentType<object>
          }
        ])
      : undefined;

    if (!location) {
      // Empty entities gain a table only once they receive components or relation tags.
      const table = this.getOrCreateTable([schema], this.getEntityTags(entity));
      const row = table.insert(entity, new Map([[schema.id, serialized]]));
      this.entityLocations.set(entity, { table, row });
      this.changeTracker.markAdded(entity, schema.id);
      this.enqueueObserverCommands(deferred);
      return this;
    }

    if (location.table.hasComponent(schema.id)) {
      location.table.writeComponent(schema, location.row, serialized);
      this.changeTracker.markChanged(entity, schema.id);
      return this;
    }

    this.migrateEntity(entity, location, schema, serialized);
    this.changeTracker.markAdded(entity, schema.id);
    this.enqueueObserverCommands(deferred);
    return this;
  }

  getComponent<TView extends object>(entity: Entity, componentType: ComponentType<TView>): TView | null {
    this.assertOwned(entity);
    if (!this.entityAllocator.isAlive(entity)) {
      return null;
    }

    const schema = this.getRegisteredComponent(componentType);
    if (schema.storage === 'object') {
      return (this.objectComponents.get(schema.id)?.get(entity) as TView | undefined) ?? null;
    }
    if (schema.storage === 'tag') {
      if (!this.tagComponents.get(schema.id)?.has(entity)) {
        return null;
      }
      let view = this.tagViews.get(schema.id);
      if (!view) {
        view = Object.freeze({});
        this.tagViews.set(schema.id, view);
      }
      return view as TView;
    }
    const location = this.entityLocations.get(entity);
    if (!location || !location.table.hasComponent(schema.id)) {
      return null;
    }

    return this.createView(schema, entity);
  }

  hasComponent<TView extends object>(entity: Entity, componentType: ComponentType<TView>): boolean {
    this.assertOwned(entity);
    const schema = this.getRegisteredComponent(componentType);
    if (schema.storage === 'object') {
      return this.objectComponents.get(schema.id)?.has(entity) === true;
    }
    if (schema.storage === 'tag') {
      return this.tagComponents.get(schema.id)?.has(entity) === true;
    }
    const location = this.entityLocations.get(entity);
    return location?.table.hasComponent(schema.id) === true;
  }

  removeComponent<TView extends object>(
    entity: Entity,
    componentType: ComponentType<TView>
  ): boolean {
    this.assertStructuralMutationAllowed();
    this.assertAlive(entity);
    const schema = this.getRegisteredComponent(componentType);
    if (schema.storage === 'object') {
      return this.removeObjectComponent(entity, schema);
    }
    if (schema.storage === 'tag') {
      return this.removeTagComponent(entity, schema);
    }
    const location = this.entityLocations.get(entity);
    if (!location || !location.table.hasComponent(schema.id)) {
      return false;
    }
    const deferred = this.dispatchObservers([
      {
        kind: 'component-removed',
        entity,
        component: schema as ComponentType<object>
      }
    ]);

    const remainingTypes = location.table.componentTypes.filter(
      (component) => component.id !== schema.id
    );
    const remainingData = new Map<string, ArrayBuffer>();
    for (const remaining of remainingTypes) {
      remainingData.set(
        remaining.id,
        location.table.readComponent(remaining, location.row)
      );
    }
    const tags = location.table.tags;
    this.removeFromTable(entity, location);
    if (remainingTypes.length > 0 || tags.size > 0) {
      const table = this.getOrCreateTable(remainingTypes, tags);
      const row = table.insert(entity, remainingData);
      this.entityLocations.set(entity, { table, row });
    }
    this.changeTracker.markRemoved(entity, [schema.id]);
    this.enqueueObserverCommands(deferred);
    return true;
  }

  isComponentRegistered<TView extends object>(componentType: ComponentType<TView>): boolean {
    return this.componentRegistry.get(componentType.id) === componentType;
  }

  markComponentChanged<TView extends object>(
    entity: Entity,
    componentType: ComponentType<TView>
  ): void {
    this.assertAlive(entity);
    const schema = this.getRegisteredComponent(componentType);
    if (!this.hasComponent(entity, schema)) {
      throw new Error(`Entity "${entity}" does not have component "${schema.id}".`);
    }
    this.changeTracker.markChanged(entity, schema.id);
  }

  query<const TComponents extends readonly ComponentType<object>[]>(
    componentTypes: TComponents,
    filter?: QueryFilter
  ): QueryBuilder<TComponents> {
    this.assertOwnedFilter(filter);
    return new QueryBuilder(this, componentTypes).withFilter(filter);
  }

  *iterateQuery<const TComponents extends readonly ComponentType<object>[]>(
    componentTypes: TComponents,
    filter: QueryFilter
  ): Iterator<QueryItem<TComponents>> {
    this.activeQueryIterations++;
    try {
      if (componentTypes.length === 0 && !this.shouldUseTablesForEmptyQuery(filter)) {
        // Unfiltered entity-only queries must include totally empty entities, which have no table.
        for (const entity of this.entityAllocator.aliveEntities()) {
          if (this.entityMatchesFilter(entity, filter)) {
            yield [entity] as unknown as QueryItem<TComponents>;
          }
        }
        return;
      }

      const schemas = componentTypes.map((componentType) =>
        this.getRegisteredComponent(componentType)
      );
      for (const table of this.findMatchingTables(schemas, filter)) {
        for (let row = 0; row < table.length; row++) {
          const entity = table.getEntity(row);
          if (!this.entityMatchesFilter(entity, filter, table)) {
            continue;
          }

          const views = schemas.map((schema) => this.getComponent(entity, schema));
          yield [entity, ...views] as unknown as QueryItem<TComponents>;
        }
      }
    } finally {
      this.activeQueryIterations--;
    }
  }

  findMatchingTables(
    componentTypes: readonly ComponentType<object>[],
    filter: QueryFilter = {}
  ): Table[] {
    this.assertOwnedFilter(filter);
    // Kept public for tests and future query planning; the pure matcher owns the tag logic.
    return findTablesMatchingQuery(this.tables.values(), componentTypes, filter, (term) =>
      this.isComponentTerm(term)
    );
  }

  addRelation(entity: Entity, relation: RelationType, target: Entity): this {
    this.assertStructuralMutationAllowed();
    this.assertAlive(entity);
    this.assertAlive(target);
    if (relation.acyclic && this.wouldCreateRelationCycle(entity, relation, target)) {
      throw new Error(
        `Relation "${relation.name}" would create a cycle from "${entity}" to "${target}".`
      );
    }
    let entityRelations = this.relations.get(entity);
    const previous = entityRelations?.get(relation.id);
    if (previous?.target === target) {
      return this;
    }
    const deferred = this.dispatchObservers([
      ...(previous
        ? ([
            {
              kind: 'relation-removed',
              entity,
              relation,
              target: previous.target
            }
          ] as const)
        : []),
      { kind: 'relation-added', entity, relation, target }
    ]);

    if (!entityRelations) {
      entityRelations = new Map<symbol, Relation>();
      this.relations.set(entity, entityRelations);
    }

    if (previous) {
      this.childOfIndex.remove(entity, previous);
    }

    // A relation is both metadata and an archetype tag. Updating it may move the entity table.
    entityRelations.set(relation.id, { relation, target });
    this.childOfIndex.add(entity, { relation, target });
    this.syncEntityArchetype(entity);
    this.enqueueObserverCommands(deferred);
    return this;
  }

  removeRelation(entity: Entity, relation: RelationType): boolean {
    this.assertStructuralMutationAllowed();
    this.assertOwned(entity);
    const entityRelations = this.relations.get(entity);
    const existing = entityRelations?.get(relation.id);
    if (!entityRelations || !existing) {
      return false;
    }
    const deferred = this.dispatchObservers([
      {
        kind: 'relation-removed',
        entity,
        relation,
        target: existing.target
      }
    ]);

    entityRelations.delete(relation.id);
    if (entityRelations.size === 0) {
      this.relations.delete(entity);
    }

    this.childOfIndex.remove(entity, existing);
    if (this.entityAllocator.isAlive(entity)) {
      this.syncEntityArchetype(entity);
    }
    this.enqueueObserverCommands(deferred);
    return true;
  }

  getRelation(entity: Entity, relation: RelationType): Relation | null {
    this.assertOwned(entity);
    return this.relations.get(entity)?.get(relation.id) ?? null;
  }

  wouldCreateRelationCycle(
    source: Entity,
    relation: RelationType,
    target: Entity
  ): boolean {
    this.assertOwned(source);
    this.assertOwned(target);
    const visited = new Set<Entity>();
    let current: Entity | null = target;
    while (current !== null) {
      if (current === source || visited.has(current)) {
        return true;
      }
      visited.add(current);
      current = this.getRelation(current, relation)?.target ?? null;
    }
    return false;
  }

  getChildren(parent: Entity): Entity[] {
    this.assertOwned(parent);
    return this.childOfIndex.getChildren(parent, (entity) => this.entityAllocator.isAlive(entity));
  }

  getParent(entity: Entity): Entity | null {
    this.assertOwned(entity);
    return this.getRelation(entity, ChildOf)?.target ?? null;
  }

  traverseDescendants(root: Entity, callback: (entity: Entity, depth: number) => void): void {
    this.assertOwned(root);
    const visit = (entity: Entity, depth: number): void => {
      callback(entity, depth);
      for (const child of this.getChildren(entity)) {
        visit(child, depth + 1);
      }
    };

    visit(root, 0);
  }

  addObserver<TView extends object>(
    descriptor: ObserverDescriptor<TView>
  ): ObserverRegistration {
    return this.observerRegistry.add(descriptor);
  }

  insertResource<T>(token: ResourceToken<T>, resource: T): this {
    this.resources.insert(token, resource);
    return this;
  }

  replaceResource<T>(token: ResourceToken<T>, resource: T): T {
    return this.resources.replace(token, resource);
  }

  getResource<T>(token: ResourceToken<T>): T | undefined {
    return this.resources.get(token);
  }

  hasResource<T>(token: ResourceToken<T>): boolean {
    return this.resources.has(token);
  }

  removeResource<T>(token: ResourceToken<T>): T | undefined {
    return this.resources.remove(token);
  }

  hasChanged(entity: Entity, componentTypes: readonly ComponentType<object>[]): boolean {
    this.assertOwned(entity);
    return this.changeTracker.hasChanged(entity, componentTypes, this.getChangeWindow());
  }

  clearTrackers(): void {
    this.changeTracker.advanceDefault();
  }

  createChangeReader(options: ChangeReaderOptions = {}): ChangeReader {
    return this.changeTracker.createReader(options);
  }

  releaseChangeReader(reader: ChangeReader): boolean {
    return this.changeTracker.releaseReader(reader);
  }

  withChangeReader<T>(reader: ChangeReader, run: () => T): T {
    if (this.activeChangeWindow) {
      throw new Error('Change reader scopes cannot be nested.');
    }
    const window = this.changeTracker.windowFor(reader);
    this.activeChangeWindow = window;
    try {
      return run();
    } finally {
      this.activeChangeWindow = undefined;
      this.changeTracker.advanceReader(reader, window.untilInclusive);
    }
  }

  runTrackedSystem<T>(systemId: string, run: () => T): T {
    let reader = this.systemChangeReaders.get(systemId);
    if (!reader) {
      reader = this.changeTracker.createSystemReader();
      this.systemChangeReaders.set(systemId, reader);
    }
    return this.withChangeReader(reader, run);
  }

  async runTrackedSystemAsync<T>(systemId: string, run: () => Promise<T>): Promise<T> {
    let reader = this.systemChangeReaders.get(systemId);
    if (!reader) {
      reader = this.changeTracker.createSystemReader();
      this.systemChangeReaders.set(systemId, reader);
    }
    if (this.activeChangeWindow) {
      throw new Error('Change reader scopes cannot be nested.');
    }
    const window = this.changeTracker.windowFor(reader);
    this.activeChangeWindow = window;
    try {
      return await run();
    } finally {
      this.activeChangeWindow = undefined;
      this.changeTracker.advanceReader(reader, window.untilInclusive);
    }
  }

  readRemoved<TView extends object>(
    component: ComponentType<TView>
  ): readonly RemovedComponent<TView>[] {
    return this.changeTracker.readRemoved(component, this.getChangeWindow());
  }

  shrinkTablesToFit(): void {
    for (const table of this.tables.values()) {
      table.shrinkToFit();
    }
  }

  private createView<TView extends object>(
    schema: PackedComponentSchema<TView>,
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

    if (
      filter.changed &&
      !this.changeTracker.hasChanged(entity, filter.changed, this.getChangeWindow())
    ) {
      return false;
    }

    if (
      filter.added &&
      !this.changeTracker.wasAdded(entity, filter.added, this.getChangeWindow())
    ) {
      return false;
    }

    return true;
  }

  private entityHasTerm(entity: Entity, term: QueryFilterTerm, table?: Table): boolean {
    if (!isRelationTerm(term)) {
      if (!table) {
        return this.hasComponent(entity, term);
      }
      return term.storage === 'packed'
        ? table.hasComponent(term.id)
        : table.hasTag(createComponentTag(term.id));
    }
    return this.getRelation(entity, term) !== null;
  }

  private isComponentTerm(term: QueryFilterTerm): term is ComponentType<object> {
    return (
      !isRelationTerm(term) && this.componentRegistry.get(term.id) === term
    );
  }

  private assertAlive(entity: Entity): void {
    this.assertOwned(entity);
    if (!this.entityAllocator.isAlive(entity)) {
      throw new Error(`Entity "${entity}" is not alive.`);
    }
  }

  private assertOwned(entity: Entity): void {
    const owner = decodeEntity(entity).worldId;
    if (owner !== this.id) {
      throw new Error(
        `Entity "${entity}" belongs to World "${owner}" and cannot be used cross-world in World "${this.id}".`
      );
    }
  }

  private assertOwnedEntityReferences(
    schema: ComponentType<object>,
    data: ComponentInput
  ): void {
    if (schema.storage !== 'packed') {
      return;
    }
    for (const field of schema.fields) {
      if (field.packedType === 'entity' && Object.hasOwn(data, field.name)) {
        const entity = data[field.name];
        if (entity !== undefined && entity !== 0) {
          this.assertOwned(entity as Entity);
        }
      }
    }
  }

  private assertOwnedFilter(filter: QueryFilter | undefined): void {
    if (filter?.relation) {
      this.assertOwned(filter.relation[1]);
    }
  }

  private assertStructuralMutationAllowed(): void {
    if (this.observerDispatchDepth > 0) {
      throw new Error(
        'Direct structural mutation is not allowed during observer dispatch; use DeferredWorld.commands.'
      );
    }
    if (this.activeQueryIterations > 0) {
      throw new Error(
        'Direct structural mutation is not allowed during query iteration; use CommandBuffer.'
      );
    }
  }

  private dispatchObservers(events: readonly ObserverEvent[]): CommandBuffer | undefined {
    if (events.length === 0) {
      return undefined;
    }
    this.observerDispatchDepth++;
    try {
      return this.observerRegistry.dispatch(events, this);
    } finally {
      this.observerDispatchDepth--;
    }
  }

  private enqueueObserverCommands(commands: CommandBuffer | undefined): void {
    if (!commands || commands.length === 0) {
      return;
    }
    const queue = this.resources.get(CommandBufferResource)!;
    queue.append(commands);
  }

  private getRegisteredComponent<TView extends object>(
    schema: ComponentType<TView>
  ): ComponentType<TView> {
    const registered = this.componentRegistry.get(schema.id);
    if (!registered || registered !== schema) {
      throw new Error(`Component "${schema.id}" has not been registered.`);
    }
    return registered as ComponentType<TView>;
  }

  private insertObjectComponent<TView extends object>(
    entity: Entity,
    schema: ObjectComponentSchema<TView>,
    data: ComponentInput
  ): void {
    const value = createObjectComponentValue(schema, data);
    let storage = this.objectComponents.get(schema.id);
    if (!storage) {
      storage = new Map();
      this.objectComponents.set(schema.id, storage);
    }
    const isAdded = !storage.has(entity);
    const deferred = isAdded
      ? this.dispatchObservers([
          { kind: 'component-added', entity, component: schema as ComponentType<object> }
        ])
      : undefined;
    storage.set(entity, value);
    if (isAdded) {
      this.syncEntityArchetype(entity);
      this.changeTracker.markAdded(entity, schema.id);
      this.enqueueObserverCommands(deferred);
    } else {
      this.changeTracker.markChanged(entity, schema.id);
    }
  }

  private insertTagComponent(entity: Entity, schema: TagComponentSchema<object>): void {
    let storage = this.tagComponents.get(schema.id);
    if (!storage) {
      storage = new Set();
      this.tagComponents.set(schema.id, storage);
    }
    if (storage.has(entity)) {
      return;
    }
    const deferred = this.dispatchObservers([
      { kind: 'component-added', entity, component: schema }
    ]);
    storage.add(entity);
    this.syncEntityArchetype(entity);
    this.changeTracker.markAdded(entity, schema.id);
    this.enqueueObserverCommands(deferred);
  }

  private removeObjectComponent<TView extends object>(
    entity: Entity,
    schema: ObjectComponentSchema<TView>
  ): boolean {
    const storage = this.objectComponents.get(schema.id);
    if (!storage?.has(entity)) {
      return false;
    }
    const deferred = this.dispatchObservers([
      { kind: 'component-removed', entity, component: schema as ComponentType<object> }
    ]);
    storage.delete(entity);
    this.syncEntityArchetype(entity);
    this.changeTracker.markRemoved(entity, [schema.id]);
    this.enqueueObserverCommands(deferred);
    return true;
  }

  private removeTagComponent(entity: Entity, schema: TagComponentSchema<object>): boolean {
    const storage = this.tagComponents.get(schema.id);
    if (!storage?.has(entity)) {
      return false;
    }
    const deferred = this.dispatchObservers([
      { kind: 'component-removed', entity, component: schema }
    ]);
    storage.delete(entity);
    this.syncEntityArchetype(entity);
    this.changeTracker.markRemoved(entity, [schema.id]);
    this.enqueueObserverCommands(deferred);
    return true;
  }

  private getEntityComponentTypes(entity: Entity): ComponentType<object>[] {
    const result: ComponentType<object>[] = [];
    for (const component of this.componentRegistry.values()) {
      if (this.hasComponent(entity, component)) {
        result.push(component);
      }
    }
    return result.sort((left, right) => left.id.localeCompare(right.id));
  }

  private getOrCreateTable(
    componentTypes: readonly PackedComponentSchema<object>[],
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
    newSchema: PackedComponentSchema<object>,
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
    schema: PackedComponentSchema<TView>
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
    return this.resources.get(SchemaRegistryResource)!;
  }

  private getChangeWindow(): ChangeWindow {
    return this.activeChangeWindow ?? this.changeTracker.windowFor();
  }

  private getEntityTags(entity: Entity): Set<string> {
    const tags = new Set<string>();
    for (const [componentId, storage] of this.objectComponents) {
      if (storage.has(entity)) {
        tags.add(createComponentTag(componentId));
      }
    }
    for (const [componentId, storage] of this.tagComponents) {
      if (storage.has(entity)) {
        tags.add(createComponentTag(componentId));
      }
    }
    for (const relation of this.relations.get(entity)?.values() ?? []) {
      // Exact targets remain indexed payloads and never fragment archetypes by target id.
      tags.add(createRelationAnyTag(relation.relation));
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
