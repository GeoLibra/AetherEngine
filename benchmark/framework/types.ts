export type BenchmarkRunProfile = 'smoke' | 'standard' | 'nightly';

export interface BenchmarkDomainDefinition {
  readonly id: string;
  readonly description: string;
  readonly pathPrefixes: readonly string[];
}

export interface BenchmarkCommandDefinition {
  readonly executable: string;
  readonly args: readonly string[];
}

export interface BenchmarkSuiteDefinition {
  readonly id: string;
  readonly description: string;
  readonly domainIds: readonly string[];
  readonly pathPrefixes: readonly string[];
  readonly command: BenchmarkCommandDefinition;
}

export interface BenchmarkManifest {
  readonly domains: readonly BenchmarkDomainDefinition[];
  readonly suites: readonly BenchmarkSuiteDefinition[];
}

export interface BenchmarkRoute {
  readonly domainIds: readonly string[];
  readonly suiteIds: readonly string[];
  readonly missingDomainIds: readonly string[];
}

export interface ManifestValidationResult {
  readonly errors: readonly string[];
  readonly uncoveredDomainIds: readonly string[];
}

export interface RenderedBenchmarkCommand {
  readonly executable: string;
  readonly args: readonly string[];
}
