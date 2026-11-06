import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { captureEnvironment, captureRepositoryState } from '../harness/environment';
import { summarize } from '../harness/statistics';
import { resolveProfile } from '../profiles';
import { observeMsaa } from './msaa';
import { observeResidency } from './residency';
import type { AcceptanceObservation } from './types';

const profile = resolveProfile(process.argv.at(-1) ?? 'smoke');
const cases: Array<{ id: string; operation: () => Promise<AcceptanceObservation> }> = [];
for (const views of profile.name === 'smoke' ? [1, 4] : [1, 8, 32]) {
  for (const samples of [1, 4] as const)
    cases.push({
      id: `opaque-views-${views}-samples-${samples}`,
      operation: () => observeMsaa(views, samples)
    });
}
for (const assets of profile.name === 'smoke' ? [16] : [16, 128, 1024]) {
  for (const mode of ['planner', 'owner-scan'] as const)
    cases.push({
      id: `residency-assets-${assets}-${mode}`,
      operation: () => observeResidency(assets, mode)
    });
}
const results: Array<
  AcceptanceObservation & {
    caseId: string;
    version: number;
    rawSamplesMs: number[];
    correctness: 'pass';
  }
> = [];
for (const scenario of cases) {
  const oracle = await scenario.operation();
  for (let warmup = 0; warmup < profile.warmupCount; warmup += 1) await scenario.operation();
  results.push({
    caseId: scenario.id,
    version: 1,
    ...oracle,
    rawSamplesMs: [] as number[],
    correctness: 'pass'
  });
}
for (let sample = 0; sample < profile.sampleCount * profile.rounds; sample += 1) {
  const order = sample % 2 === 0 ? cases : [...cases].reverse();
  for (const scenario of order) {
    const result = results.find((entry) => entry.caseId === scenario.id);
    assert.ok(result);
    const started = performance.now();
    const observation = await scenario.operation();
    result.rawSamplesMs.push(performance.now() - started);
    assert.equal(observation.checksum, result.checksum);
  }
}
for (const assets of profile.name === 'smoke' ? [16] : [16, 128, 1024]) {
  const planner = results.find((result) => result.caseId === `residency-assets-${assets}-planner`);
  const reference = results.find(
    (result) => result.caseId === `residency-assets-${assets}-owner-scan`
  );
  assert.equal(planner?.checksum, reference?.checksum);
}
const report = {
  schemaVersion: 1,
  suite: 'p1-rendering-acceptance',
  profile: profile.name,
  createdAt: new Date().toISOString(),
  environment: captureEnvironment(),
  repository: captureRepositoryState(),
  protocol: {
    warmupCount: profile.warmupCount,
    sampleCountPerRound: profile.sampleCount,
    rounds: profile.rounds,
    order: 'alternating forward/reverse',
    backend: 'Null',
    includes: 'fixture setup, production operations, oracle checks and cleanup',
    timing: 'descriptive CPU wall clock; concurrent work may contend; no GPU timing',
    comparisons:
      '1x versus 4x quality baseline; planner versus lower-bound owner scan without ranking'
  },
  results: results.map((result) => ({ ...result, summary: summarize(result.rawSamplesMs) }))
};
const output = resolve('benchmark/artifacts/p1-rendering-acceptance');
mkdirSync(output, { recursive: true });
const path = resolve(
  output,
  `p1-rendering-acceptance-${profile.name}-${report.createdAt.replaceAll(':', '-')}.json`
);
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`P1 rendering acceptance: ${results.length} cases passed; artifact: ${path}`);
