import { createRelationAnyTag, createRelationTargetTag } from './relation';
import type { Table } from './table';
import type { ComponentSchema, ComponentType, QueryFilter, QueryFilterTerm } from './types';

export function findMatchingTables(
  tables: Iterable<Table>,
  componentTypes: readonly ComponentSchema<object>[],
  filter: QueryFilter,
  isComponentTerm: (term: QueryFilterTerm) => term is ComponentType<object>
): Table[] {
  // Compile query filters into table-level component/tag requirements first. Row-level checks
  // still validate per-entity relation payloads and frame-local change state.
  const requiredComponentIds = new Set(componentTypes.map((componentType) => componentType.id));
  const excludedComponentIds = new Set<string>();
  const requiredTags = new Set<string>();
  const excludedTags = new Set<string>();

  if (filter.relation) {
    requiredTags.add(createRelationTargetTag(filter.relation[0], filter.relation[1]));
  }

  for (const term of filter.with ?? []) {
    if (isComponentTerm(term)) {
      requiredComponentIds.add(term.id);
    } else {
      requiredTags.add(createRelationAnyTag(term));
    }
  }

  for (const term of filter.without ?? []) {
    if (isComponentTerm(term)) {
      excludedComponentIds.add(term.id);
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
