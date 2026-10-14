import type {
  AssetResidencyEvictionOwner,
  AssetResidencyPressurePlan
} from './types/residency-pressure-types';

/**
 * Applies an eviction proposal through pool owners that revalidate leases and resource identity.
 * Returns actual bytes released and rejected keys; CPU and GPU pools keep separate ownership.
 * @throws If a pool has no owner or an owner reports an invalid byte count.
 */
export function applyAssetResidencyPressure(
  plan: AssetResidencyPressurePlan,
  owners: ReadonlyMap<string, AssetResidencyEvictionOwner>
): Readonly<{ releasedBytes: number; rejectedKeys: readonly string[] }> {
  for (const candidate of plan.candidates) {
    if (!owners.has(candidate.pool))
      throw new Error(`Residency pool "${candidate.pool}" has no eviction owner.`);
  }
  let releasedBytes = 0;
  const rejectedKeys: string[] = [];
  for (const candidate of plan.candidates) {
    const bytes = owners.get(candidate.pool)!.evict(candidate);
    if (bytes === null) {
      rejectedKeys.push(candidate.key);
      continue;
    }
    if (!Number.isSafeInteger(bytes) || bytes < 0 || !Number.isSafeInteger(releasedBytes + bytes)) {
      throw new Error('Residency eviction owner returned an invalid byte count.');
    }
    releasedBytes += bytes;
  }
  return Object.freeze({ releasedBytes, rejectedKeys: Object.freeze(rejectedKeys) });
}
