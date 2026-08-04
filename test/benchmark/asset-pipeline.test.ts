import { describe, expect, test } from 'vitest';
import {
  createAssetRequestFixture,
  scheduleAssetRequestsBucketed,
  scheduleAssetRequestsReference
} from '../../benchmark/asset-pipeline/model';

describe('asset pipeline benchmark semantic oracle', () => {
  test('bucketed scheduler matches the full-sort reference with merged consumers and budgets', () => {
    const demands = createAssetRequestFixture(128, 0x5eed);
    demands.push({ ...demands[7]!, consumerId: 'duplicate-consumer', explicitPriority: 99 });

    const budget = { maxRequests: 24, maxBytes: 2_000_000 } as const;
    const reference = scheduleAssetRequestsReference(demands, budget);
    const subject = scheduleAssetRequestsBucketed(demands, budget);

    expect(subject.oracleHash).toBe(reference.oracleHash);
    expect(subject.admitted).toEqual(reference.admitted);
    expect(subject.counters.duplicateConsumers).toBe(1);
    expect(subject.counters.admittedRequests).toBeLessThanOrEqual(budget.maxRequests);
    expect(subject.counters.admittedBytes).toBeLessThanOrEqual(budget.maxBytes);
  });

  test('uses stable request key as the final tie-breaker', () => {
    const base = {
      consumerId: 'consumer',
      priorityClass: 'visible' as const,
      explicitPriority: 10,
      screenContribution: 0.5,
      age: 4,
      estimatedBytes: 64
    };
    const demands = [
      { ...base, key: 'asset/z' },
      { ...base, key: 'asset/a' },
      { ...base, key: 'asset/m' }
    ];

    const result = scheduleAssetRequestsBucketed(demands, {
      maxRequests: 3,
      maxBytes: 1_000
    });

    expect(result.admitted.map((item) => item.key)).toEqual(['asset/a', 'asset/m', 'asset/z']);
  });
});
