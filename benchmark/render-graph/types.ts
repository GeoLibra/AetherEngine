export interface RenderGraphWorkloadOptions {
  readonly seed: number;
  readonly passCount: number;
  readonly resourceCount: number;
  readonly accessDensity: number;
}

export interface RenderGraphAccess {
  readonly resourceIndex: number;
  readonly mode: 'read' | 'write';
}

export interface RenderGraphPassWorkload {
  readonly registrationIndex: number;
  readonly accesses: readonly RenderGraphAccess[];
}

export interface RenderGraphWorkload {
  readonly version: 1;
  readonly options: RenderGraphWorkloadOptions;
  readonly accessesPerPass: number;
  readonly passes: readonly RenderGraphPassWorkload[];
}

export interface RenderGraphReferenceResult {
  readonly order: readonly number[];
  readonly edgeChecksum: string;
  readonly retainedPasses: number;
  readonly accessesExamined: number;
  readonly overlapComparisons: number;
}

export interface RenderGraphScenario {
  readonly scenarioId: 'hazard-compile-v1';
  readonly scenarioVersion: 1;
  readonly workload: RenderGraphWorkload;
  runReference(): RenderGraphReferenceResult;
}
