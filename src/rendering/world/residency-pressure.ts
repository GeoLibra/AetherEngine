import { AssetPayloadRegistry } from '../../assets/runtime';
import {
  applyAssetResidencyPressure,
  planAssetResidencyPressure
} from '../../assets/request-scheduler';
import type { AssetHandle } from '../../assets/types';
import { PreparedAssetRegistry } from './prepared-assets';
import type { PreparedVariantKey } from './types';

/** Explicit authority-owned residency set and eviction ranking signals. */
export interface ResidencyPressureSubject {
  readonly handle: AssetHandle<unknown>;
  readonly gpuVariants: readonly PreparedVariantKey[];
  readonly priority: number;
  readonly lastUseTick: number;
  readonly rebuildCost: number;
}

/**
 * Applies byte pressure to the supplied complete CPU residency set through registry owners.
 * Revalidates the exact CPU revision before eviction and preserves GPU ownership separately.
 * Returns actual released bytes and remaining pressure; pinned bytes remain accounted.
 * @throws If the budget or residency facts are invalid.
 */
export function enforceCpuResidencyBudget(
  payloads: AssetPayloadRegistry,
  budgetBytes: number,
  subjects: readonly ResidencyPressureSubject[]
): Readonly<{ releasedBytes: number; remainingPressureBytes: number }> {
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 0)
    throw new Error('CPU residency budget must be a non-negative safe integer.');
  const identities = new Map<string, { handle: AssetHandle<unknown>; version: number }>();
  const candidates = subjects.flatMap((subject) =>
    payloads
      .inspect(subject.handle)
      .revisions.filter((revision) => revision.current)
      .map((revision) => {
        const key = `${subject.handle.assetId}:${revision.version}`;
        identities.set(key, { handle: subject.handle, version: revision.version });
        return {
          key,
          pool: 'cpu',
          bytes: revision.bytes,
          activeLeases: revision.activeLeases,
          activeSubmissions: 0,
          priority: subject.priority,
          lastUseTick: subject.lastUseTick,
          rebuildCost: subject.rebuildCost
        };
      })
  );
  const plan = planAssetResidencyPressure(
    'cpu',
    Math.max(0, payloads.residentBytes - budgetBytes),
    candidates
  );
  const result = applyAssetResidencyPressure(
    plan,
    new Map([
      [
        'cpu',
        {
          evict(candidate) {
            const identity = identities.get(candidate.key)!;
            const current = payloads
              .inspect(identity.handle)
              .revisions.find((revision) => revision.current);
            if (current?.version !== identity.version) return null;
            const outcome = payloads.evict(identity.handle);
            return outcome.kind === 'evicted' ? outcome.bytes : null;
          }
        }
      ]
    ])
  );
  return Object.freeze({
    releasedBytes: result.releasedBytes,
    remainingPressureBytes: Math.max(0, payloads.residentBytes - budgetBytes)
  });
}

/**
 * Enforces a byte budget for one GPU device generation using authoritative variant snapshots.
 * Unknown byte sizes fail explicitly; owners preserve variants acquired after planning.
 * @throws If the budget, device generation, or supplied residency facts are invalid.
 */
export function enforceGpuResidencyBudget(
  prepared: PreparedAssetRegistry,
  deviceGeneration: number,
  budgetBytes: number,
  subjects: readonly ResidencyPressureSubject[]
): Readonly<{ releasedBytes: number; remainingPressureBytes: number }> {
  if (
    !Number.isSafeInteger(deviceGeneration) ||
    deviceGeneration < 0 ||
    !Number.isSafeInteger(budgetBytes) ||
    budgetBytes < 0
  )
    throw new Error('GPU generation and residency budget must be non-negative safe integers.');
  const pool = `gpu:${deviceGeneration}`;
  const identities = new Map<string, PreparedVariantKey>();
  const candidates = subjects.flatMap((subject) =>
    subject.gpuVariants.flatMap((key) => {
      if (key.deviceGeneration !== deviceGeneration) return [];
      const snapshot = prepared.inspect(key);
      if (snapshot === undefined) return [];
      if (snapshot.bytes === null)
        throw new Error('GPU pressure requires authoritative byte sizes.');
      const identity = JSON.stringify([
        key.assetId,
        key.payloadVersion,
        key.deviceGeneration,
        key.featurePolicyKey,
        key.abiVersion
      ]);
      identities.set(identity, key);
      return [
        {
          key: identity,
          pool,
          bytes: snapshot.bytes,
          activeLeases: snapshot.activeLeases,
          activeSubmissions: snapshot.activeSubmissions,
          priority: subject.priority,
          lastUseTick: subject.lastUseTick,
          rebuildCost: subject.rebuildCost
        }
      ];
    })
  );
  const totalBytes = candidates.reduce((total, candidate) => total + candidate.bytes, 0);
  const plan = planAssetResidencyPressure(pool, Math.max(0, totalBytes - budgetBytes), candidates);
  const result = applyAssetResidencyPressure(
    plan,
    new Map([
      [
        pool,
        {
          evict(candidate) {
            const key = identities.get(candidate.key)!;
            const snapshot = prepared.inspect(key);
            if (snapshot === undefined) return null;
            return prepared.evictUnreferenced(key) ? snapshot.bytes : null;
          }
        }
      ]
    ])
  );
  return Object.freeze({
    releasedBytes: result.releasedBytes,
    remainingPressureBytes: Math.max(0, totalBytes - result.releasedBytes - budgetBytes)
  });
}
