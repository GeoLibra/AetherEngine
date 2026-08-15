export type QueryCandidateSource = 'entities' | 'tables' | 'object-component' | 'relation-target';

export interface QueryDebugPlan {
  readonly queryId: number;
  readonly candidateSource: QueryCandidateSource;
  readonly matchedArchetypeIds: readonly number[];
  readonly catalogTablesExamined: number;
  readonly cacheHits: number;
  readonly rowFilters: number;
}
