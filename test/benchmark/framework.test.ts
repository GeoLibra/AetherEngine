import { describe, expect, test, vi } from 'vitest';
import { parseChangedPaths } from '../../benchmark/framework/git-changes';
import { parseFrameworkCliOptions } from '../../benchmark/framework/cli-options';
import { BENCHMARK_MANIFEST } from '../../benchmark/framework/manifest';
import { routeChangedFiles } from '../../benchmark/framework/routing';
import { renderSuiteCommand, runBenchmarkPlan } from '../../benchmark/framework/runner';
import type { BenchmarkManifest } from '../../benchmark/framework/types';
import { validateManifest } from '../../benchmark/framework/validation';

describe('benchmark manifest', () => {
  test('registers ECS while keeping future performance domains visible', () => {
    const result = validateManifest(BENCHMARK_MANIFEST);

    expect(result.errors).toEqual([]);
    expect(result.uncoveredDomainIds).toContain('rendering');
    expect(result.uncoveredDomainIds).not.toContain('ecs');
  });

  test('rejects duplicate IDs and suites that reference unknown domains', () => {
    const invalid: BenchmarkManifest = {
      domains: [
        { id: 'same', description: 'one', pathPrefixes: ['src/one/'] },
        { id: 'same', description: 'two', pathPrefixes: ['src/two/'] }
      ],
      suites: [{
        id: 'broken',
        description: 'broken',
        domainIds: ['missing'],
        pathPrefixes: ['benchmark/broken/'],
        command: { executable: 'npm', args: ['run', 'bench:broken', '--', '--profile', '{profile}'] }
      }]
    };

    const result = validateManifest(invalid);

    expect(result.errors.join('\n')).toContain('Duplicate benchmark domain id "same"');
    expect(result.errors.join('\n')).toContain('unknown domain "missing"');
  });
});

describe('changed-file routing', () => {
  test('selects the ECS suite for ECS source and suite-owned files', () => {
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['src/ecs/world.ts']).suiteIds).toEqual(['ecs']);
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['benchmark/scenarios/definitions.ts']).suiteIds)
      .toEqual(['ecs']);
  });

  test('requires a suite when Rendering work starts', () => {
    const route = routeChangedFiles(BENCHMARK_MANIFEST, ['src/rendering/render-graph.ts']);

    expect(route.domainIds).toEqual(['rendering']);
    expect(route.suiteIds).toEqual([]);
    expect(route.missingDomainIds).toEqual(['rendering']);
  });

  test('also recognizes the Rendering design directory and ignores unrelated files', () => {
    expect(routeChangedFiles(
      BENCHMARK_MANIFEST,
      ['engine/design/v2/04-rendering/01-render-world.md', 'README.md']
    ).missingDomainIds).toEqual(['rendering']);
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['README.md']).domainIds).toEqual([]);
  });
});

describe('framework command planning', () => {
  test('parses and deduplicates Git name-only output', () => {
    expect(parseChangedPaths('src/ecs/world.ts\r\nsrc/ecs/world.ts\n\nREADME.md\n'))
      .toEqual(['README.md', 'src/ecs/world.ts']);
  });

  test('renders the requested profile without a shell command string', () => {
    const suite = BENCHMARK_MANIFEST.suites[0];
    if (!suite) throw new Error('Expected the ECS suite.');

    expect(renderSuiteCommand(suite, 'standard')).toEqual({
      executable: 'npm',
      args: ['run', 'bench:ecs', '--', '--profile', 'standard']
    });
  });

  test('parses changed and all commands and rejects unknown options', () => {
    expect(parseFrameworkCliOptions(['changed', '--profile', 'standard', '--file', 'src/ecs/world.ts', '--dry-run']))
      .toEqual({ command: 'changed', profile: 'standard', files: ['src/ecs/world.ts'], dryRun: true });
    expect(parseFrameworkCliOptions(['all'])).toEqual({ command: 'all', profile: 'smoke', dryRun: false });
    expect(() => parseFrameworkCliOptions(['changed', '--quick'])).toThrow('Unknown benchmark framework option');
  });

  test('fails changed runs with uncovered domains before executing commands', async () => {
    const execute = vi.fn();

    await expect(runBenchmarkPlan(
      BENCHMARK_MANIFEST,
      { mode: 'changed', profile: 'smoke', files: ['src/rendering/render-graph.ts'], dryRun: false },
      execute
    )).rejects.toThrow('rendering');
    expect(execute).not.toHaveBeenCalled();
  });

  test('runs only routed suites and supports dry-run planning', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: 'artifact.json\n', stderr: '' });

    const result = await runBenchmarkPlan(
      BENCHMARK_MANIFEST,
      { mode: 'changed', profile: 'smoke', files: ['src/ecs/world.ts'], dryRun: true },
      execute
    );

    expect(result.suiteIds).toEqual(['ecs']);
    expect(result.commands).toEqual([{
      executable: 'npm',
      args: ['run', 'bench:ecs', '--', '--profile', 'smoke']
    }]);
    expect(execute).not.toHaveBeenCalled();
  });
});
