import type { Table } from './table';
import type { QueryCandidateSource, QueryDebugPlan } from './query-types';
import type { ComponentType, QueryFilter, QueryItem } from './types';

export interface QueryTableRefresh {
  readonly version: number;
  readonly examined: number;
  readonly matching: readonly Table[];
}

export interface QueryStateRuntime<TComponents extends readonly ComponentType<object>[]> {
  refresh(
    componentTypes: TComponents,
    filter: QueryFilter,
    sinceVersion: number
  ): QueryTableRefresh;
  iterate(
    componentTypes: TComponents,
    filter: QueryFilter,
    matchingTables: readonly Table[],
    recordRowFilter: () => void
  ): Iterator<QueryItem<TComponents>>;
}

export class QueryState<TComponents extends readonly ComponentType<object>[]>
  implements Iterable<QueryItem<TComponents>>
{
  private readonly filter: QueryFilter;
  private readonly matchingTables: Table[] = [];
  private readonly matchedTableIds = new Set<number>();
  private catalogVersion = 0;
  private catalogTablesExamined = 0;
  private cacheHits = 0;
  private rowFilters = 0;

  constructor(
    readonly id: number,
    private readonly componentTypes: TComponents,
    filter: QueryFilter,
    private readonly candidateSource: QueryCandidateSource,
    private readonly runtime: QueryStateRuntime<TComponents>
  ) {
    this.filter = freezeQueryFilter(filter);
  }

  get plan(): QueryDebugPlan {
    return Object.freeze({
      queryId: this.id,
      candidateSource: this.candidateSource,
      matchedArchetypeIds: Object.freeze(this.matchingTables.map((table) => table.id)),
      catalogTablesExamined: this.catalogTablesExamined,
      cacheHits: this.cacheHits,
      rowFilters: this.rowFilters
    });
  }

  [Symbol.iterator](): Iterator<QueryItem<TComponents>> {
    this.refreshMatchingTables();
    return this.runtime.iterate(
      this.componentTypes,
      this.filter,
      this.matchingTables,
      () => this.rowFilters++
    );
  }

  private refreshMatchingTables(): void {
    const refresh = this.runtime.refresh(
      this.componentTypes,
      this.filter,
      this.catalogVersion
    );
    this.catalogVersion = refresh.version;
    this.catalogTablesExamined += refresh.examined;
    if (refresh.examined === 0) {
      this.cacheHits++;
    }
    for (const table of refresh.matching) {
      if (!this.matchedTableIds.has(table.id)) {
        this.matchedTableIds.add(table.id);
        this.matchingTables.push(table);
      }
    }
  }
}

function freezeQueryFilter(filter: QueryFilter): QueryFilter {
  return Object.freeze({
    ...(filter.with === undefined ? {} : { with: Object.freeze([...filter.with]) }),
    ...(filter.without === undefined
      ? {}
      : { without: Object.freeze([...filter.without]) }),
    ...(filter.changed === undefined
      ? {}
      : { changed: Object.freeze([...filter.changed]) }),
    ...(filter.added === undefined ? {} : { added: Object.freeze([...filter.added]) }),
    ...(filter.relation === undefined
      ? {}
      : {
          relation: Object.freeze([...filter.relation]) as readonly [
            (typeof filter.relation)[0],
            (typeof filter.relation)[1]
          ]
        })
  });
}
