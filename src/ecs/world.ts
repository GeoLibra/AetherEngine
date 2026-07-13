import { ChangeReader, ChangeTracker } from './change-tracker';
import { ArchetypeCatalog } from './archetype-catalog';
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
import { QueryState } from './query-state';
import type { QueryCandidateSource } from './query-types';
import { RelationIndex } from './relation-index';
import type { MonotonicClock, WorldMetricsSnapshot, WorldOptions } from './world-metrics';
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
import { Table } from './table';
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
  WorldId,
  WorldState
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
  private readonly archetypes = new ArchetypeCatalog();
  private readonly entityLocations = new Map<Entity, EntityLocation>();
  private readonly componentRegistry = new Map<string, ComponentType<object>>();
  private readonly objectComponents = new Map<string, Map<Entity, object>>();
  private readonly tagComponents = new Map<string, Set<Entity>>();
  private readonly tagViews = new Map<string, object>();
  private readonly resources = new ResourceStore();
  private readonly changeTracker = new ChangeTracker();
  private readonly systemChangeReaders = new Map<string, ChangeReader>();
  private activeChangeWindow: ChangeWindow | undefined;

  // Relation payloads and exact targets are indexed separately from archetype type tags.
  private readonly relationIndex = new RelationIndex();
  private readonly childOfIndex = new ChildOfIndex();
  private readonly observerRegistry = new ObserverRegistry();
  private activeQueryIterations = 0;
  private nextQueryId = 0;
  private observerDispatchDepth = 0;
  private queryCacheHits = 0;
  private queryRowFilters = 0;
  private observerTimeMs = 0;
  private lastCommandBatchSize = 0;
  private currentState: WorldState = 'created';
  private readonly clock: MonotonicClock;

  constructor(
    schemaRegistry: SchemaRegistry = new SchemaRegistry(),
    options: WorldOptions = {}
  ) {
    this.id = createWorldId();
    this.clock = options.clock ?? { now: () => 0 };
    this.entityAllocator = new EntityAllocator(this.id);
    this.resources.insert(SchemaRegistryResource, schemaRegistry, true);
    this.resources.insert(CommandBufferResource, new CommandBuffer(), true);
    this.resources.insert(EventRegistryResource, new EventRegistry(), true);
    this.resources.insert(StateRegistryResource, new StateRegistry(), true);
    this.resources.insert(DiagnosticStoreResource, new DiagnosticStore(), true);
  }

  get state(): WorldState {
    return this.currentState;
  }

  start(): void {
    this.assertUsable();
    if (this.currentState === 'running') {
      return;
    }
    if (this.currentState !== 'created') {
      throw new Error(`Cannot start World while it is in state "${this.currentState}".`);
    }
    this.currentState = 'running';
  }

  clear(): void {
    this.assertStructuralMutationAllowed();
    if (this.currentState === 'clearing') {
      throw new Error('Cannot clear World while it is already clearing.');
    }
    const previousState = this.currentState;
    this.currentState = 'clearing';
    try {
      for (const entity of this.entityAllocator.aliveEntities()) {
        this.despawn(entity);
      }
    } finally {
      this.currentState = previousState;
    }
  }

  destroy(): void {
    if (this.currentState === 'destroyed') {
      return;
    }
    if (this.currentState === 'clearing') {
      throw new Error('Cannot destroy World while it is clearing.');
    }
    this.assertStructuralMutationAllowed();
    let clearError: unknown;
    let clearFailed = false;
    try {
      this.clear();
    } catch (error) {
      clearError = error;
      clearFailed = true;
    }

    this.entityAllocator.clear();
    this.archetypes.clear();
    this.entityLocations.clear();
    this.componentRegistry.clear();
    this.objectComponents.clear();
    this.tagComponents.clear();
    this.tagViews.clear();
    this.relationIndex.clear();
    this.childOfIndex.clear();
    this.changeTracker.clear();
    this.systemChangeReaders.clear();
    this.observerRegistry.clear();
    this.resources.clear();
    this.activeChangeWindow = undefined;
    this.activeQueryIterations = 0;
    this.nextQueryId = 0;
    this.observerDispatchDepth = 0;
    this.currentState = 'destroyed';

    if (clearFailed) {
      throw clearError;
    }
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
    const outgoingRelations = this.relationIndex.outgoing(entity);
    const incomingRelations = this.relationIndex
      .incomingTo(entity)
      .filter(({ source }) => source !== entity);
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
        ({ source, relation }): ObserverEvent => ({
          kind: 'relation-removed',
          entity: source,
          relation: relation.relation,
          target: relation.target
        })
      ),
      { kind: 'entity-despawned', entity }
    ]);

    // Remove outgoing relation indexes before deleting the source relation map.
    for (const relation of outgoingRelations) {
      this.childOfIndex.remove(entity, relation);
    }

    this.relationIndex.removeSource(entity);
    for (const storage of this.objectComponents.values()) {
      storage.delete(entity);
    }
    for (const storage of this.tagComponents.values()) {
      storage.delete(entity);
    }

    // Observer validation already succeeded for the full despawn mutation. Remove incoming
    // edges without redispatching so one failing observer cannot leave a half-detached graph.
    for (const { source, relation } of incomingRelations) {
      this.relationIndex.remove(source, relation.relation);
      this.childOfIndex.remove(source, relation);
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

    if (!location) {
      // Empty entities gain a table only once they receive components or relation tags.
      const table = this.getOrCreateTable([schema], this.getEntityTags(entity));
      const row = table.insert(entity, new Map([[schema.id, serialized]]));
      this.entityLocations.set(entity, { table, row });
      let deferred: CommandBuffer | undefined;
      try {
        deferred = this.dispatchComponentAdded(entity, schema);
      } catch (error) {
        this.removeFromTable(entity, { table, row });
        throw error;
      }
      this.changeTracker.markAdded(entity, schema.id);
      this.enqueueObserverCommands(deferred);
      return this;
    }

    if (location.table.hasComponent(schema.id)) {
      location.table.writeComponent(schema, location.row, serialized);
      this.changeTracker.markChanged(entity, schema.id);
      return this;
    }

    const previousComponents = this.readTableComponents(location);
    this.migrateEntity(entity, location, schema, serialized);
    let deferred: CommandBuffer | undefined;
    try {
      deferred = this.dispatchComponentAdded(entity, schema);
    } catch (error) {
      this.restoreTableEntity(entity, location.table, previousComponents);
      throw error;
    }
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
      const table = this.archetypes.transition(
        location.table,
        `remove:component:${schema.id}`,
        remainingTypes,
        tags
      );
      const row = table.insert(entity, remainingData);
      this.entityLocations.set(entity, { table, row });
    }
    this.changeTracker.markRemoved(entity, [schema.id]);
    this.enqueueObserverCommands(deferred);
    return true;
  }

  isComponentRegistered<TView extends object>(componentType: ComponentType<TView>): boolean {
    this.assertUsable();
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
    this.assertUsable();
    this.assertOwnedFilter(filter);
    return new QueryBuilder(this, componentTypes).withFilter(filter);
  }

  createQueryState<const TComponents extends readonly ComponentType<object>[]>(
    componentTypes: TComponents,
    filter: QueryFilter = {}
  ): QueryState<TComponents> {
    this.assertUsable();
    this.assertOwnedFilter(filter);
    const candidateSource = this.selectQueryCandidateSource(componentTypes, filter);
    return new QueryState(this.nextQueryId++, componentTypes, filter, candidateSource, {
      refresh: (types, compiledFilter, sinceVersion) => {
        const candidates = this.archetypes.tablesSince(sinceVersion);
        return {
          version: this.archetypes.version,
          examined: candidates.length,
          matching: findTablesMatchingQuery(candidates, types, compiledFilter, (term) =>
            this.isComponentTerm(term)
          )
        };
      },
      iterate: (types, compiledFilter, matchingTables, recordRowFilter) =>
        this.iterateMatchedQuery(
          types,
          compiledFilter,
          matchingTables,
          candidateSource,
          recordRowFilter
        ),
      recordCacheHit: () => this.queryCacheHits++,
      recordRowFilter: () => this.queryRowFilters++
    });
  }

  metrics(): WorldMetricsSnapshot {
    this.assertUsable();
    const tables = [...this.archetypes.values()];
    const archetypes = this.archetypes.snapshot();
    return Object.freeze({
      aliveEntities: [...this.entityAllocator.aliveEntities()].length,
      tables: tables.length,
      chunks: tables.reduce((sum, table) => sum + table.chunkCount, 0),
      allocatedRows: tables.reduce((sum, table) => sum + table.allocatedCapacity, 0),
      liveRows: tables.reduce((sum, table) => sum + table.length, 0),
      migrations: archetypes.migrations,
      archetypeEdgeHits: archetypes.edgeHits,
      archetypeEdgeMisses: archetypes.edgeMisses,
      queryCacheHits: this.queryCacheHits,
      rowFilters: this.queryRowFilters,
      relationEdges: this.relationIndex.edgeCount,
      lastCommandBatchSize: this.lastCommandBatchSize,
      observerTimeMs: this.observerTimeMs,
      removedLogAge: this.changeTracker.removedLogAge
    });
  }

  /** Records the successful apply boundary owned by CommandBuffer. */
  recordCommandBatch(commandCount: number): void {
    this.assertUsable();
    this.lastCommandBatchSize = commandCount;
  }

  iterateQuery<const TComponents extends readonly ComponentType<object>[]>(
    componentTypes: TComponents,
    filter: QueryFilter
  ): Iterator<QueryItem<TComponents>> {
    return this.createQueryState(componentTypes, filter)[Symbol.iterator]();
  }

  findMatchingTables(
    componentTypes: readonly ComponentType<object>[],
    filter: QueryFilter = {}
  ): Table[] {
    this.assertUsable();
    this.assertOwnedFilter(filter);
    // Kept public for tests and future query planning; the pure matcher owns the tag logic.
    return findTablesMatchingQuery(this.archetypes.values(), componentTypes, filter, (term) =>
      this.isComponentTerm(term)
    );
  }

  private *iterateMatchedQuery<
    const TComponents extends readonly ComponentType<object>[]
  >(
    componentTypes: TComponents,
    filter: QueryFilter,
    matchingTables: readonly Table[],
    candidateSource: QueryCandidateSource,
    recordRowFilter: () => void
  ): Iterator<QueryItem<TComponents>> {
    this.assertUsable();
    this.activeQueryIterations++;
    try {
      if (componentTypes.length === 0 && !this.shouldUseTablesForEmptyQuery(filter)) {
        for (const entity of this.entityAllocator.aliveEntities()) {
          recordRowFilter();
          if (this.entityMatchesFilter(entity, filter)) {
            yield [entity] as unknown as QueryItem<TComponents>;
          }
        }
        return;
      }

      const schemas = componentTypes.map((componentType) =>
        this.getRegisteredComponent(componentType)
      );
      if (candidateSource === 'relation-target' && filter.relation) {
        const [relation, target] = filter.relation;
        const matchingTableIds = new Set(matchingTables.map((table) => table.id));
        for (const entity of this.relationIndex.incoming(relation, target)) {
          const location = this.entityLocations.get(entity);
          if (!location || !matchingTableIds.has(location.table.id)) {
            continue;
          }
          recordRowFilter();
          if (!this.entityMatchesFilter(entity, filter, location.table)) {
            continue;
          }
          const views = schemas.map((schema) => this.getComponent(entity, schema));
          yield [entity, ...views] as unknown as QueryItem<TComponents>;
        }
        return;
      }
      if (candidateSource === 'object-component') {
        const matchingTableIds = new Set(matchingTables.map((table) => table.id));
        for (const entity of this.getObjectQueryCandidates(componentTypes, filter)) {
          const location = this.entityLocations.get(entity);
          if (!location || !matchingTableIds.has(location.table.id)) {
            continue;
          }
          recordRowFilter();
          if (!this.entityMatchesFilter(entity, filter, location.table)) {
            continue;
          }
          const views = schemas.map((schema) => this.getComponent(entity, schema));
          yield [entity, ...views] as unknown as QueryItem<TComponents>;
        }
        return;
      }
      for (const table of matchingTables) {
        for (let row = 0; row < table.length; row++) {
          const entity = table.getEntity(row);
          recordRowFilter();
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

  addRelation(entity: Entity, relation: RelationType, target: Entity): this {
    this.assertStructuralMutationAllowed();
    this.assertAlive(entity);
    this.assertAlive(target);
    if (relation.acyclic && this.wouldCreateRelationCycle(entity, relation, target)) {
      throw new Error(
        `Relation "${relation.name}" would create a cycle from "${entity}" to "${target}".`
      );
    }
    const previous = this.relationIndex.get(entity, relation);
    if (previous?.target === target) {
      return this;
    }
    const removedDeferred = previous
      ? this.dispatchObservers([{
          kind: 'relation-removed',
          entity,
          relation,
          target: previous.target
        }])
      : undefined;

    if (previous) {
      this.childOfIndex.remove(entity, previous);
    }

    // A relation is both metadata and an archetype tag. Updating it may move the entity table.
    const value = { relation, target };
    this.relationIndex.set(entity, value);
    this.childOfIndex.add(entity, value);
    this.syncEntityArchetype(entity);
    let addedDeferred: CommandBuffer | undefined;
    try {
      addedDeferred = this.dispatchObservers([
        { kind: 'relation-added', entity, relation, target }
      ]);
    } catch (error) {
      this.relationIndex.remove(entity, relation);
      this.childOfIndex.remove(entity, value);
      if (previous) {
        this.relationIndex.set(entity, previous);
        this.childOfIndex.add(entity, previous);
      }
      this.syncEntityArchetype(entity);
      throw error;
    }
    this.enqueueObserverCommands(removedDeferred);
    this.enqueueObserverCommands(addedDeferred);
    return this;
  }

  removeRelation(entity: Entity, relation: RelationType): boolean {
    this.assertStructuralMutationAllowed();
    this.assertOwned(entity);
    const existing = this.relationIndex.get(entity, relation);
    if (!existing) {
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

    this.relationIndex.remove(entity, relation);
    this.childOfIndex.remove(entity, existing);
    if (this.entityAllocator.isAlive(entity)) {
      this.syncEntityArchetype(entity);
    }
    this.enqueueObserverCommands(deferred);
    return true;
  }

  getRelation(entity: Entity, relation: RelationType): Relation | null {
    this.assertOwned(entity);
    return this.relationIndex.get(entity, relation);
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
    this.assertUsable();
    return this.observerRegistry.add(descriptor);
  }

  insertResource<T>(token: ResourceToken<T>, resource: T): this {
    this.assertUsable();
    this.resources.insert(token, resource);
    return this;
  }

  replaceResource<T>(token: ResourceToken<T>, resource: T): T {
    this.assertUsable();
    return this.resources.replace(token, resource);
  }

  getResource<T>(token: ResourceToken<T>): T | undefined {
    this.assertUsable();
    return this.resources.get(token);
  }

  hasResource<T>(token: ResourceToken<T>): boolean {
    this.assertUsable();
    return this.resources.has(token);
  }

  removeResource<T>(token: ResourceToken<T>): T | undefined {
    this.assertUsable();
    return this.resources.remove(token);
  }

  hasChanged(entity: Entity, componentTypes: readonly ComponentType<object>[]): boolean {
    this.assertOwned(entity);
    return this.changeTracker.hasChanged(entity, componentTypes, this.getChangeWindow());
  }

  clearTrackers(): void {
    this.assertUsable();
    this.changeTracker.advanceDefault();
  }

  createChangeReader(options: ChangeReaderOptions = {}): ChangeReader {
    this.assertUsable();
    return this.changeTracker.createReader(options);
  }

  releaseChangeReader(reader: ChangeReader): boolean {
    this.assertUsable();
    return this.changeTracker.releaseReader(reader);
  }

  withChangeReader<T>(reader: ChangeReader, run: () => T): T {
    this.assertUsable();
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
    this.assertUsable();
    let reader = this.systemChangeReaders.get(systemId);
    if (!reader) {
      reader = this.changeTracker.createSystemReader();
      this.systemChangeReaders.set(systemId, reader);
    }
    return this.withChangeReader(reader, run);
  }

  async runTrackedSystemAsync<T>(systemId: string, run: () => Promise<T>): Promise<T> {
    this.assertUsable();
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
    this.assertUsable();
    return this.changeTracker.readRemoved(component, this.getChangeWindow());
  }

  shrinkTablesToFit(): void {
    this.assertUsable();
    for (const table of this.archetypes.values()) {
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
    this.assertUsable();
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
    this.assertUsable();
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

  private assertUsable(): void {
    if (this.currentState === 'destroyed') {
      throw new Error(`World "${this.id}" is destroyed.`);
    }
  }

  private dispatchObservers(events: readonly ObserverEvent[]): CommandBuffer | undefined {
    if (events.length === 0) {
      return undefined;
    }
    this.observerDispatchDepth++;
    const startedAt = this.clock.now();
    try {
      return this.observerRegistry.dispatch(events, this);
    } finally {
      this.observerTimeMs += Math.max(0, this.clock.now() - startedAt);
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
    storage.set(entity, value);
    if (isAdded) {
      this.syncEntityArchetype(entity);
      let deferred: CommandBuffer | undefined;
      try {
        deferred = this.dispatchComponentAdded(entity, schema);
      } catch (error) {
        storage.delete(entity);
        this.syncEntityArchetype(entity);
        throw error;
      }
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
    storage.add(entity);
    this.syncEntityArchetype(entity);
    let deferred: CommandBuffer | undefined;
    try {
      deferred = this.dispatchComponentAdded(entity, schema);
    } catch (error) {
      storage.delete(entity);
      this.syncEntityArchetype(entity);
      throw error;
    }
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
    return this.archetypes.getOrCreate(componentTypes, tags);
  }

  private dispatchComponentAdded(
    entity: Entity,
    component: ComponentType<object>
  ): CommandBuffer | undefined {
    return this.dispatchObservers([{ kind: 'component-added', entity, component }]);
  }

  private readTableComponents(location: EntityLocation): Map<string, ArrayBuffer> {
    const components = new Map<string, ArrayBuffer>();
    for (const component of location.table.componentTypes) {
      components.set(
        component.id,
        location.table.readComponent(component, location.row)
      );
    }
    return components;
  }

  private restoreTableEntity(
    entity: Entity,
    table: Table,
    components: ReadonlyMap<string, ArrayBuffer>
  ): void {
    const current = this.entityLocations.get(entity);
    if (current) this.removeFromTable(entity, current);
    const row = table.insert(entity, components);
    this.entityLocations.set(entity, { table, row });
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

    const newTable = this.archetypes.transition(
      oldLocation.table,
      `add:component:${newSchema.id}`,
      [...oldTypes, newSchema],
      oldTags
    );
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

    const operation = getTagTransitionOperation(location.table.tags, tags);
    const table = this.archetypes.transition(
      location.table,
      operation,
      componentTypes,
      tags
    );
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
    for (const relation of this.relationIndex.outgoing(entity)) {
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

  private selectQueryCandidateSource(
    componentTypes: readonly ComponentType<object>[],
    filter: QueryFilter
  ): QueryCandidateSource {
    if (filter.relation) {
      return 'relation-target';
    }
    if (
      componentTypes.length === 0 &&
      filter.relation === undefined &&
      (filter.with?.length ?? 0) === 0
    ) {
      return 'entities';
    }
    return this.getRequiredObjectComponents(componentTypes, filter).length > 0
      ? 'object-component'
      : 'tables';
  }

  private getObjectQueryCandidates(
    componentTypes: readonly ComponentType<object>[],
    filter: QueryFilter
  ): Iterable<Entity> {
    const objectComponents = this.getRequiredObjectComponents(componentTypes, filter);
    let smallest: Map<Entity, object> | undefined;
    for (const component of objectComponents) {
      const storage = this.objectComponents.get(component.id) ?? new Map<Entity, object>();
      if (!smallest || storage.size < smallest.size) {
        smallest = storage;
      }
    }
    return smallest?.keys() ?? [];
  }

  private getRequiredObjectComponents(
    componentTypes: readonly ComponentType<object>[],
    filter: QueryFilter
  ): ObjectComponentSchema<object>[] {
    const result = componentTypes.filter(
      (component): component is ObjectComponentSchema<object> => component.storage === 'object'
    );
    for (const term of filter.with ?? []) {
      if (!isRelationTerm(term) && term.storage === 'object' && !result.includes(term)) {
        result.push(term);
      }
    }
    return result;
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

function getTagTransitionOperation(
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

function isRelationTerm(term: QueryFilterTerm): term is RelationType {
  return typeof term.id === 'symbol';
}
