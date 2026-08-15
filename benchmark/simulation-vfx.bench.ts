import { bench, expect } from 'vitest';
import { createVFXSpawnBatch, evaluateVertexAnalyticVFX } from './simulation-vfx/model';

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';
const counts =
  profile === 'nightly' ? [10_000, 100_000] : profile === 'standard' ? [10_000] : [1_000];

for (const count of counts) {
  const batch = createVFXSpawnBatch(count, 0x1337);
  const oracleAt0 = evaluateVertexAnalyticVFX(batch, 0.5);

  bench(`vertex-analytic vfx evaluate ${count} particles at dt=0.5`, () => {
    const result = evaluateVertexAnalyticVFX(batch, 0.5);
    expect(result.activeCount).toBe(oracleAt0.activeCount);
    expect(result.stateChecksum).toBe(oracleAt0.stateChecksum);
  });
}
