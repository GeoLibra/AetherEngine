import { createRelationAnyTag } from './relation';
import type { Table } from './table';
import type { ComponentType, QueryFilter, QueryFilterTerm } from './types';

export function createComponentTag(componentId: string): string {
  return `component:${componentId}`;
}

export function findMatchingTables(
  tables: Iterable<Table>,
  componentTypes: readonly ComponentType<object>[],
  filter: QueryFilter,
  isComponentTerm: (term: QueryFilterTerm) => term is ComponentType<object>
): Table[] {
  // Compile query filters into table-level component/tag requirements first. Row-level checks
  // still validate per-entity relation payloads and frame-local change state.
  const requiredComponentIds = new Set(
    componentTypes
      .filter((componentType) => componentType.storage === 'packed')
      .map((componentType) => componentType.id)
  );
  const excludedComponentIds = new Set<string>();
  const requiredTags = new Set<string>();
  const excludedTags = new Set<string>();

  for (const componentType of componentTypes) {
    if (componentType.storage !== 'packed') {
      requiredTags.add(createComponentTag(componentType.id));
    }
  }

  if (filter.relation) {
    // Exact targets are row payloads. The table signature only contains relation type,
    // preventing one archetype per target in hierarchies and other high-cardinality graphs.
    requiredTags.add(createRelationAnyTag(filter.relation[0]));
  }

  for (const term of filter.with ?? []) {
    if (isComponentTerm(term)) {
      if (term.storage === 'packed') {
        requiredComponentIds.add(term.id);
      } else {
        requiredTags.add(createComponentTag(term.id));
      }
    } else {
      requiredTags.add(createRelationAnyTag(term));
    }
  }

  for (const term of filter.without ?? []) {
    if (isComponentTerm(term)) {
      if (term.storage === 'packed') {
        excludedComponentIds.add(term.id);
      } else {
        excludedTags.add(createComponentTag(term.id));
      }
    } else {
      excludedTags.add(createRelationAnyTag(term));
    }
  }

  return [...tables].filter(
    (table) =>
      hasAllComponents(table, requiredComponentIds) &&
      hasNoComponents(table, excludedComponentIds) &&
      hasAllTags(table, requiredTags) &&
      hasNoTags(table, excludedTags)
  );
}

function hasAllComponents(table: Table, componentIds: ReadonlySet<string>): boolean {
  for (const componentId of componentIds) {
    if (!table.hasComponent(componentId)) {
      return false;
    }
  }
  return true;
}

function hasNoComponents(table: Table, componentIds: ReadonlySet<string>): boolean {
  for (const componentId of componentIds) {
    if (table.hasComponent(componentId)) {
      return false;
    }
  }
  return true;
}

function hasAllTags(table: Table, tags: ReadonlySet<string>): boolean {
  for (const tag of tags) {
    if (!table.hasTag(tag)) {
      return false;
    }
  }
  return true;
}

function hasNoTags(table: Table, tags: ReadonlySet<string>): boolean {
  for (const tag of tags) {
    if (table.hasTag(tag)) {
      return false;
    }
  }
  return true;
}
