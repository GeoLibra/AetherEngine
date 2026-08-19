import type { BenchmarkManifest, ManifestValidationResult } from './types';

function duplicateIds(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

export function validateManifest(manifest: BenchmarkManifest): ManifestValidationResult {
  const errors: string[] = [];
  const domainIds = new Set(manifest.domains.map((domain) => domain.id));

  for (const id of duplicateIds(manifest.domains.map((domain) => domain.id))) {
    errors.push(`Duplicate benchmark domain id "${id}".`);
  }
  for (const id of duplicateIds(manifest.suites.map((suite) => suite.id))) {
    errors.push(`Duplicate benchmark suite id "${id}".`);
  }
  for (const suite of manifest.suites) {
    for (const domainId of suite.domainIds) {
      if (!domainIds.has(domainId)) {
        errors.push(`Benchmark suite "${suite.id}" references unknown domain "${domainId}".`);
      }
    }
    const placeholders = suite.command.args.filter((argument) => argument === '{profile}').length;
    if (placeholders !== 1) {
      errors.push(
        `Benchmark suite "${suite.id}" command must contain exactly one {profile} argument.`
      );
    }
    if (!suite.command.executable.trim()) {
      errors.push(`Benchmark suite "${suite.id}" command executable must not be empty.`);
    }
  }

  const covered = new Set(manifest.suites.flatMap((suite) => suite.domainIds));
  return Object.freeze({
    errors: Object.freeze(errors),
    uncoveredDomainIds: Object.freeze(
      manifest.domains
        .map((domain) => domain.id)
        .filter((id) => !covered.has(id))
        .sort()
    )
  });
}

export function assertValidManifest(manifest: BenchmarkManifest): void {
  const result = validateManifest(manifest);
  if (result.errors.length > 0) {
    throw new Error(`Invalid benchmark manifest:\n- ${result.errors.join('\n- ')}`);
  }
}
