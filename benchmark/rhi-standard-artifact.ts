import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, release, totalmem } from 'node:os';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { NullDevice } from '../src';

const profile = process.argv.at(-1);
if (profile !== 'standard' && profile !== 'nightly') {
  throw new Error(
    `RHI artifact requires standard or nightly profile; received ${profile ?? '<missing>'}.`
  );
}

const commandBufferCount = profile === 'standard' ? 5_000 : 20_000;
const warmupCount = 5;
const sampleCount = 30;
for (let index = 0; index < warmupCount; index++) runScenario(commandBufferCount);
const rawSamplesMs = Array.from({ length: sampleCount }, () => {
  const start = performance.now();
  const oracle = runScenario(commandBufferCount);
  const elapsed = performance.now() - start;
  if (oracle.commandBufferCount !== commandBufferCount || oracle.submissions !== 1) {
    throw new Error('RHI benchmark structural oracle failed.');
  }
  return elapsed;
});

const createdAt = new Date().toISOString();
const cpu = cpus()[0]?.model ?? 'unknown';
const artifact = {
  schemaVersion: 1,
  suite: 'rhi-command',
  profile,
  createdAt,
  environment: {
    runtime: process.version,
    platform: process.platform,
    arch: process.arch,
    release: release(),
    cpu,
    logicalCpuCount: cpus().length,
    totalMemoryBytes: totalmem()
  },
  protocol: { warmupCount, sampleCount },
  scenario: {
    id: 'null-command-record-submit-v1',
    commandBufferCount,
    oracle: { commandBufferCount, submissions: 1 }
  },
  rawSamplesMs
};
const directory = resolve('benchmark/artifacts/rhi');
mkdirSync(directory, { recursive: true });
const path = resolve(directory, `rhi-command-${profile}-${createdAt.replaceAll(':', '-')}.json`);
writeFileSync(path, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(`RHI ${profile} artifact: ${path}`);

function runScenario(commandCount: number): {
  readonly commandBufferCount: number;
  readonly submissions: number;
} {
  const device = new NullDevice();
  const commandBuffers = [];
  for (let index = 0; index < commandCount; index++) {
    const encoder = device.createCommandEncoder({ label: `artifact-frame-${index}` });
    encoder.pushDebugGroup('frame');
    encoder.popDebugGroup();
    commandBuffers.push(encoder.finish());
  }
  const submission = device.queue.submit(commandBuffers);
  if (submission.status !== 'completed')
    throw new Error('RHI benchmark submission did not complete.');
  return Object.freeze({
    commandBufferCount: commandBuffers.length,
    submissions: device.queue.metrics().submitted
  });
}
