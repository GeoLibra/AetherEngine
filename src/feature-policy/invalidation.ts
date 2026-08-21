import type {
  FeaturePolicyCacheInvalidation,
  FeaturePolicyCacheDomain,
  FeaturePolicySnapshot
} from './types';

/**
 * Computes the deterministic cache compatibility changes between two policies.
 * Revision-only changes are ignored because revision is not part of a domain identity.
 */
export function diffFeaturePolicyCacheDomains(
  previous: FeaturePolicySnapshot,
  next: FeaturePolicySnapshot
): readonly FeaturePolicyCacheInvalidation[] {
  const domains = new Set<FeaturePolicyCacheDomain>([
    ...previous.cacheDomainHashes.keys(),
    ...next.cacheDomainHashes.keys()
  ]);
  const invalidations: FeaturePolicyCacheInvalidation[] = [];
  for (const domain of [...domains].sort()) {
    const previousHash = previous.cacheDomainHashes.get(domain) ?? null;
    const nextHash = next.cacheDomainHashes.get(domain) ?? null;
    if (previousHash !== nextHash) invalidations.push({ domain, previousHash, nextHash });
  }
  return invalidations;
}
