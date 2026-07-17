import type { BenchmarkManifest, BenchmarkRoute } from './types';
import { assertValidManifest } from './validation';

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function matchesPrefix(path: string, prefixes: readonly string[]): boolean {
  const normalized = normalizePath(path);
  return prefixes.some((prefix) => normalized.startsWith(normalizePath(prefix)));
}

export function routeChangedFiles(
  manifest: BenchmarkManifest,
  changedFiles: readonly string[]
): BenchmarkRoute {
  assertValidManifest(manifest);
  const domainIds = manifest.domains
    .filter((domain) => changedFiles.some((path) => matchesPrefix(path, domain.pathPrefixes)))
    .map((domain) => domain.id)
    .sort();
  const matchedDomains = new Set(domainIds);
  const directlyMatched = manifest.suites.filter((suite) =>
    changedFiles.some((path) => matchesPrefix(path, suite.pathPrefixes))
  );
  const directlyCoveredDomains = new Set(directlyMatched.flatMap((suite) => suite.domainIds));
  const suites = manifest.suites.filter(
    (suite) =>
      directlyMatched.includes(suite) ||
      suite.domainIds.some(
        (domainId) => matchedDomains.has(domainId) && !directlyCoveredDomains.has(domainId)
      )
  );
  const coveredDomains = new Set(suites.flatMap((suite) => suite.domainIds));

  return Object.freeze({
    domainIds: Object.freeze(domainIds),
    suiteIds: Object.freeze(suites.map((suite) => suite.id).sort()),
    missingDomainIds: Object.freeze(domainIds.filter((id) => !coveredDomains.has(id)))
  });
}
