import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runCommand } from '../../benchmark/harness/child-process';
import { writeArtifact } from '../../benchmark/harness/reporter';
import { samplePrepared } from '../../benchmark/harness/worker-runner';
import { parseCliOptions } from '../../benchmark/run';
import type { PreparedBenchmark } from '../../benchmark/adapters/types';

function fakePrepared(value = 3): PreparedBenchmark {
  return {
    expectedChecksum: { count: 2, value: 3 },
    reset() {},
    validate: () => ({ count: 2, value }),
    runIteration: () => ({ count: 2, value }),
    counters: () => Object.freeze({ rowsExamined: 2 }),
    dispose() {}
  };
}

describe('benchmark worker sampling', () => {
  test('times only runIteration and retains every raw sample', () => {
    let resets = 0;
    let clock = 0;
    const prepared = fakePrepared();
    prepared.reset = () => {
      resets++;
      clock += 100;
    };
    const now = () => clock;
    prepared.runIteration = () => {
      clock += 5;
      return { count: 2, value: 3 };
    };

    const result = samplePrepared(
      prepared,
      { name: 'smoke', warmupCount: 1, sampleCount: 3, rounds: 1 },
      now,
      'fake-case'
    );

    expect(result.samplesMs).toEqual([5, 5, 5]);
    expect(result.summary.median).toBe(5);
    expect(resets).toBe(6); // pre-check, warmup, three samples, post-check
    expect(result.checksum).toEqual({ count: 2, value: 3 });
  });

  test('fails before reporting samples when correctness differs', () => {
    expect(() =>
      samplePrepared(
        fakePrepared(4),
        { name: 'smoke', warmupCount: 1, sampleCount: 3, rounds: 1 },
        () => 0,
        'broken-case'
      )
    ).toThrow('broken-case');
  });
});

describe('benchmark reporting and CLI', () => {
  test('writes a schema-versioned artifact with raw samples', () => {
    const directory = mkdtempSync(join(tmpdir(), 'aether-benchmark-'));
    const report = {
      schemaVersion: 1 as const,
      profile: 'smoke' as const,
      seed: 42,
      createdAt: '2026-07-15T00:00:00.000Z',
      environment: {
        node: 'v1', v8: 'v1', platform: 'darwin' as const, release: 'x',
        architecture: 'arm64', cpu: 'test', logicalCpuCount: 1, totalMemoryBytes: 1
      },
      repository: { commit: 'abc', dirty: false },
      results: []
    };

    const path = writeArtifact(report, directory);
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof report;

    expect(parsed).toEqual(report);
    expect(path.startsWith(directory)).toBe(true);
  });

  test('parses filters without accepting unknown flags', () => {
    expect(parseCliOptions(['--profile', 'standard', '--scenario', 'dense-update', '--subject', 'aether-public']))
      .toEqual({ profile: 'standard', scenario: 'dense-update', subject: 'aether-public' });
    expect(() => parseCliOptions(['--fast'])).toThrow('Unknown benchmark option');
  });
});

test('surfaces child process failures with exit details', async () => {
  await expect(runCommand(process.execPath, ['-e', 'process.stderr.write("boom"); process.exit(7)']))
    .rejects.toThrow('exit code 7');
});
