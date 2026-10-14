import type {
  AssetResidencyCandidate,
  AssetResidencyPressurePlan
} from './types/residency-pressure-types';

/**
 * Proposes cold, inexpensive residency evictions within one CPU or device-generation pool.
 * Bytes are non-negative safe integers; ticks use the owner's monotonic reference frame.
 * Does not mutate inputs or release resources. Owners must revalidate leases and submissions.
 * @throws If candidate facts, pool identity, or requested bytes are invalid or duplicated.
 */
export function planAssetResidencyPressure(
  pool: string,
  requiredBytes: number,
  candidates: readonly AssetResidencyCandidate[]
): AssetResidencyPressurePlan {
  if (!pool.trim()) throw new Error('Residency pressure pool must be non-empty.');
  assertCount(requiredBytes);
  const keys = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.key.trim() || !candidate.pool.trim() || keys.has(candidate.key)) {
      throw new Error('Residency candidates must have unique non-empty identities.');
    }
    keys.add(candidate.key);
    for (const value of [
      candidate.bytes,
      candidate.activeLeases,
      candidate.activeSubmissions,
      candidate.lastUseTick
    ])
      assertCount(value);
    if (
      !Number.isFinite(candidate.priority) ||
      !Number.isFinite(candidate.rebuildCost) ||
      candidate.rebuildCost < 0
    ) {
      throw new Error('Residency priority and rebuild cost must be finite.');
    }
  }
  const eligible = candidates.filter(
    (candidate) =>
      candidate.pool === pool &&
      candidate.activeLeases === 0 &&
      candidate.activeSubmissions === 0 &&
      candidate.bytes > 0
  );
  eligible.sort(
    (left, right) =>
      left.priority - right.priority ||
      left.lastUseTick - right.lastUseTick ||
      left.rebuildCost - right.rebuildCost ||
      (left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  );
  const selected: AssetResidencyCandidate[] = [];
  let proposedBytes = 0;
  for (const candidate of eligible) {
    if (proposedBytes >= requiredBytes) break;
    proposedBytes += candidate.bytes;
    if (!Number.isSafeInteger(proposedBytes))
      throw new Error('Residency byte total exceeds safe integer range.');
    selected.push(Object.freeze({ ...candidate }));
  }
  return Object.freeze({
    candidates: Object.freeze(selected),
    proposedBytes,
    unmetBytes: Math.max(0, requiredBytes - proposedBytes)
  });
}

function assertCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Residency counters must be non-negative safe integers.');
}
