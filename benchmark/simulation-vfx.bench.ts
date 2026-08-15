import { bench, expect } from 'vitest';
import {
  createVFXSpawnBatch,
  evaluateVertexAnalyticVFX,
  evaluateVFXReferenceScalar
} from './simulation-vfx/model';

const profile = process.env.AETHER_BENCH_PROFILE ?? 'smoke';
const counts =
  profile === 'nightly' ? [10_000, 100_000] : profile === 'standard' ? [10_000] : [1_000];

for (const count of counts) {
  const batch = createVFXSpawnBatch(count, 0x1337);
  // Independent scalar reference run outside benchmark timing loop
  const reference = evaluateVFXReferenceScalar(batch, 0.5);
  const subjectCheck = evaluateVertexAnalyticVFX(batch, 0.5);
  expect(subjectCheck.stateChecksum).toBe(reference.stateChecksum);
  expect(subjectCheck.activeCount).toBe(reference.activeCount);

  let sink = 0;
  bench(`vertex-analytic vfx evaluate ${count} particles at dt=0.5`, () => {
    const result = evaluateVertexAnalyticVFX(batch, 0.5);
    sink += result.stateChecksum;
  });

  bench(`scalar reference evaluate ${count} particles at dt=0.5`, () => {
    const result = evaluateVFXReferenceScalar(batch, 0.5);
    sink += result.stateChecksum;
  });
}
