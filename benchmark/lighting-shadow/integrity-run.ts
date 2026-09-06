import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { summarize } from '../harness/statistics';
import {
  declareLightListBenchmarkGraph,
  createLightListPackingWorkload,
  packLightListBenchmarkInput
} from './light-list-declaration';
import { runShadowAtlasCompactionReference, runShadowAtlasCompactionSubject } from './scenario';

const profile = process.argv.at(-1);
const scales = { smoke: 16, standard: 64, nightly: 256 } as const;
if (profile !== 'smoke' && profile !== 'standard' && profile !== 'nightly') {
  throw new Error(`Unknown lighting/shadow integrity profile: ${profile ?? '<missing>'}`);
}

const count = scales[profile];
const subject = runShadowAtlasCompactionSubject(count, 4);
const reference = runShadowAtlasCompactionReference(count, 4);
if (JSON.stringify(subject) !== JSON.stringify(reference)) {
  throw new Error('Shadow-atlas compaction does not match its independent oracle');
}
const sampleCounts = { smoke: 5, standard: 30, nightly: 60 } as const;
const warmupCounts = { smoke: 2, standard: 10, nightly: 20 } as const;
const declarationResults = [100, 10_000, 1_000_000].map((receiverCount) => {
  const rawSamplesMs: number[] = [];
  const rounds = warmupCounts[profile] + sampleCounts[profile];
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    const observation = declareLightListBenchmarkGraph(receiverCount);
    const duration = performance.now() - start;
    if (observation.passCount !== 1 || observation.resourceCount !== 6) {
      throw new Error('Light-list declaration benchmark structural oracle failed.');
    }
    if (round >= warmupCounts[profile]) rawSamplesMs.push(duration);
  }
  return Object.freeze({
    receiverCount,
    passCount: 1,
    resourceCount: 6,
    rawSamplesMs,
    summary: summarize(rawSamplesMs)
  });
});
const packingResults = [100, 1_000, 10_000].map((count) => {
  const workload = createLightListPackingWorkload(count);
  const rawSamplesMs: number[] = [];
  const rounds = warmupCounts[profile] + sampleCounts[profile];
  for (let round = 0; round < rounds; round++) {
    const start = performance.now();
    const packed = packLightListBenchmarkInput(workload);
    const duration = performance.now() - start;
    if (packed.lights.length !== 4 + count * 8 || packed.receivers.length !== 4 + count * 12)
      throw new Error('Light-list packed ABI benchmark structural oracle failed.');
    if (round >= warmupCounts[profile]) rawSamplesMs.push(duration);
  }
  return Object.freeze({ count, rawSamplesMs, summary: summarize(rawSamplesMs) });
});
const createdAt = new Date().toISOString();
const artifactDirectory = resolve('benchmark/artifacts/lighting-shadow');
mkdirSync(artifactDirectory, { recursive: true });
const artifactPath = resolve(
  artifactDirectory,
  `lighting-shadow-${profile}-${createdAt.replaceAll(':', '-')}.json`
);
writeFileSync(
  artifactPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      profile,
      createdAt,
      environment: {
        node: process.version,
        platform: process.platform,
        architecture: process.arch
      },
      repository: {
        commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
        dirty: execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim() !== ''
      },
      declarationResults,
      packingResults
    },
    null,
    2
  )}\n`,
  'utf8'
);
console.log(
  `Lighting/shadow integrity: count=${count} checksum=${subject.checksum} counters=${JSON.stringify(subject.counters)}\nArtifact: ${artifactPath}`
);
