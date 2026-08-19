import type { ChangeTracker } from '../reactive/change-tracker';
import type { RelationIndex } from '../relation';
import type { Table } from '../storage/table';
import { createComponentTag } from '../storage/table-query';
import type {
  ChangeWindow,
  ComponentType,
  Entity,
  ObjectComponentSchema,
  QueryCandidateSource,
  QueryFilter,
  QueryFilterTerm,
  QueryItem,
  Relation,
  RelationType
} from '../types';
import type { EntityLocation } from '../storage/entity-migrator';

export function isRelationTerm(term: QueryFilterTerm): term is RelationType {
  return typeof term.id === 'symbol';
}

export function isComponentTerm(
  term: QueryFilterTerm,
  componentRegistry: ReadonlyMap<string, ComponentType<object>>
): term is ComponentType<object> {
  return !isRelationTerm(term) && componentRegistry.get(term.id) === term;
}

export function shouldUseTablesForEmptyQuery(filter: QueryFilter): boolean {
  return Boolean(filter.relation || (filter.with?.length ?? 0) > 0);
}

export function getRequiredObjectComponents(
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

export function selectQueryCandidateSource(
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
  return getRequiredObjectComponents(componentTypes, filter).length > 0
    ? 'object-component'
    : 'tables';
}

export function getObjectQueryCandidates(
  componentTypes: readonly ComponentType<object>[],
  filter: QueryFilter,
  objectComponents: ReadonlyMap<string, ReadonlyMap<Entity, object>>
): Iterable<Entity> {
  const required = getRequiredObjectComponents(componentTypes, filter);
  let smallest: ReadonlyMap<Entity, object> | undefined;
  for (const component of required) {
    const storage = objectComponents.get(component.id) ?? new Map<Entity, object>();
    if (!smallest || storage.size < smallest.size) {
      smallest = storage;
    }
  }
  return smallest?.keys() ?? [];
}

export function entityHasTerm(
  entity: Entity,
  term: QueryFilterTerm,
  table: Table | undefined,
  hasComponent: (entity: Entity, schema: ComponentType<object>) => boolean,
  getRelation: (entity: Entity, relation: RelationType) => Relation | null
): boolean {
  if (!isRelationTerm(term)) {
    if (!table) {
      return hasComponent(entity, term);
    }
    return term.storage === 'packed'
      ? table.hasComponent(term.id)
      : table.hasTag(createComponentTag(term.id));
  }
  return getRelation(entity, term) !== null;
}

export function entityMatchesFilter(
  entity: Entity,
  filter: QueryFilter,
  table: Table | undefined,
  changeTracker: ChangeTracker,
  changeWindow: ChangeWindow,
  hasComponent: (entity: Entity, schema: ComponentType<object>) => boolean,
  getRelation: (entity: Entity, relation: RelationType) => Relation | null
): boolean {
  if (filter.relation) {
    const [relation, target] = filter.relation;
    if (getRelation(entity, relation)?.target !== target) {
      return false;
    }
  }

  for (const term of filter.with ?? []) {
    if (!entityHasTerm(entity, term, table, hasComponent, getRelation)) {
      return false;
    }
  }

  for (const term of filter.without ?? []) {
    if (entityHasTerm(entity, term, table, hasComponent, getRelation)) {
      return false;
    }
  }

  if (filter.changed && !changeTracker.hasChanged(entity, filter.changed, changeWindow)) {
    return false;
  }

  if (filter.added && !changeTracker.wasAdded(entity, filter.added, changeWindow)) {
    return false;
  }

  return true;
}

export interface QueryExecutionContext {
  readonly aliveEntities: () => Iterable<Entity>;
  readonly getRegisteredComponent: <TView extends object>(
    schema: ComponentType<TView>
  ) => ComponentType<TView>;
  readonly getComponent: <TView extends object>(
    entity: Entity,
    schema: ComponentType<TView>
  ) => TView | null;
  readonly hasComponent: (entity: Entity, schema: ComponentType<object>) => boolean;
  readonly getRelation: (entity: Entity, relation: RelationType) => Relation | null;
  readonly relationIndex: RelationIndex;
  readonly objectComponents: ReadonlyMap<string, ReadonlyMap<Entity, object>>;
  readonly entityLocations: ReadonlyMap<Entity, EntityLocation>;
  readonly changeTracker: ChangeTracker;
  readonly getChangeWindow: () => ChangeWindow;
}

export function* iterateMatchedQuery<const TComponents extends readonly ComponentType<object>[]>(
  componentTypes: TComponents,
  filter: QueryFilter,
  matchingTables: readonly Table[],
  candidateSource: QueryCandidateSource,
  recordRowFilter: () => void,
  context: QueryExecutionContext
): IterableIterator<QueryItem<TComponents>> {
  if (componentTypes.length === 0 && !shouldUseTablesForEmptyQuery(filter)) {
    for (const entity of context.aliveEntities()) {
      recordRowFilter();
      if (
        entityMatchesFilter(
          entity,
          filter,
          undefined,
          context.changeTracker,
          context.getChangeWindow(),
          context.hasComponent,
          context.getRelation
        )
      ) {
        yield [entity] as unknown as QueryItem<TComponents>;
      }
    }
    return;
  }

  const schemas = componentTypes.map((componentType) =>
    context.getRegisteredComponent(componentType)
  );

  if (candidateSource === 'relation-target' && filter.relation) {
    const [relation, target] = filter.relation;
    const matchingTableIds = new Set(matchingTables.map((table) => table.id));
    for (const entity of context.relationIndex.incoming(relation, target)) {
      const location = context.entityLocations.get(entity);
      if (!location || !matchingTableIds.has(location.table.id)) {
        continue;
      }
      recordRowFilter();
      if (
        !entityMatchesFilter(
          entity,
          filter,
          location.table,
          context.changeTracker,
          context.getChangeWindow(),
          context.hasComponent,
          context.getRelation
        )
      ) {
        continue;
      }
      const views = schemas.map((schema) => context.getComponent(entity, schema));
      yield [entity, ...views] as unknown as QueryItem<TComponents>;
    }
    return;
  }

  if (candidateSource === 'object-component') {
    const matchingTableIds = new Set(matchingTables.map((table) => table.id));
    for (const entity of getObjectQueryCandidates(
      componentTypes,
      filter,
      context.objectComponents
    )) {
      const location = context.entityLocations.get(entity);
      if (!location || !matchingTableIds.has(location.table.id)) {
        continue;
      }
      recordRowFilter();
      if (
        !entityMatchesFilter(
          entity,
          filter,
          location.table,
          context.changeTracker,
          context.getChangeWindow(),
          context.hasComponent,
          context.getRelation
        )
      ) {
        continue;
      }
      const views = schemas.map((schema) => context.getComponent(entity, schema));
      yield [entity, ...views] as unknown as QueryItem<TComponents>;
    }
    return;
  }

  for (const table of matchingTables) {
    for (let row = 0; row < table.length; row++) {
      const entity = table.getEntity(row);
      recordRowFilter();
      if (
        !entityMatchesFilter(
          entity,
          filter,
          table,
          context.changeTracker,
          context.getChangeWindow(),
          context.hasComponent,
          context.getRelation
        )
      ) {
        continue;
      }
      const views = schemas.map((schema) => context.getComponent(entity, schema));
      yield [entity, ...views] as unknown as QueryItem<TComponents>;
    }
  }
}
