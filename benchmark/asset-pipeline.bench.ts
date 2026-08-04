import { bench, expect } from 'vitest';
import {
  createAssetRequestFixture,
  scheduleAssetRequestsBucketed,
  scheduleAssetRequestsReference
} from './asset-pipeline/model';

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';
const sizes =
  profile === 'nightly' ? [10_000, 100_000] : profile === 'standard' ? [10_000] : [1_000];

for (const size of sizes) {
  const fixture = createAssetRequestFixture(size, 0x5eed);
  for (let index = 0; index < Math.floor(size / 10); index++) {
    fixture.push({
      ...fixture[index]!,
      consumerId: `duplicate/${index}`,
      explicitPriority: 100
    });
  }
  const budget = Object.freeze({
    maxRequests: Math.max(1, Math.floor(size / 4)),
    maxBytes: Math.max(262_144, size * 65_536)
  });
  const expected = scheduleAssetRequestsReference(fixture, budget);

  bench(`reference full-sort schedules ${size} asset demands`, () => {
    const result = scheduleAssetRequestsReference(fixture, budget);
    expect(result.oracleHash).toBe(expected.oracleHash);
  });

  bench(`bucketed subject schedules ${size} asset demands`, () => {
    const result = scheduleAssetRequestsBucketed(fixture, budget);
    expect(result.oracleHash).toBe(expected.oracleHash);
    expect(result.counters.duplicateConsumers).toBe(Math.floor(size / 10));
  });
}
