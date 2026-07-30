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
    expect(result.uncoveredDomainIds).not.toContain('rendering');
    expect(result.uncoveredDomainIds).not.toContain('ecs');
  });

  test('rejects duplicate IDs and suites that reference unknown domains', () => {
    const invalid: BenchmarkManifest = {
      domains: [
        { id: 'same', description: 'one', pathPrefixes: ['src/one/'] },
        { id: 'same', description: 'two', pathPrefixes: ['src/two/'] }
      ],
      suites: [
        {
          id: 'broken',
          description: 'broken',
          domainIds: ['missing'],
          pathPrefixes: ['benchmark/broken/'],
          command: {
            executable: 'npm',
            args: ['run', 'bench:broken', '--', '--profile', '{profile}']
          }
        }
      ]
    };

    const result = validateManifest(invalid);

    expect(result.errors.join('\n')).toContain('Duplicate benchmark domain id "same"');
    expect(result.errors.join('\n')).toContain('unknown domain "missing"');
  });
});

describe('changed-file routing', () => {
  test('selects the ECS suite for ECS source and suite-owned files', () => {
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['src/ecs/world.ts']).suiteIds).toEqual(['ecs']);
    expect(
      routeChangedFiles(BENCHMARK_MANIFEST, ['benchmark/scenarios/definitions.ts']).suiteIds
    ).toEqual(['ecs']);
  });

  test('requires a suite when Rendering work starts', () => {
    const route = routeChangedFiles(BENCHMARK_MANIFEST, ['src/rendering/render-graph.ts']);

    expect(route.domainIds).toEqual(['rendering']);
    expect(route.suiteIds).toEqual(['render-world']);
    expect(route.missingDomainIds).toEqual([]);
  });

  test('also recognizes the Rendering design directory and ignores unrelated files', () => {
    expect(
      routeChangedFiles(BENCHMARK_MANIFEST, [
        'engine/design/v2/04-rendering/01-render-world.md',
        'README.md'
      ]).suiteIds
    ).toEqual(['render-world']);
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['README.md']).domainIds).toEqual([]);
  });

  test('routes Shader work to the dedicated semantic suite', () => {
    expect(
      routeChangedFiles(BENCHMARK_MANIFEST, ['engine/design/v2/04-rendering/02-shader-system.md'])
        .suiteIds
    ).toEqual(['shader-system']);
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['src/shader/compiler.ts']).suiteIds).toEqual([
      'shader-system'
    ]);
  });

  test('routes Runtime and Jobs to their shared deterministic suite', () => {
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['src/app/schedule.ts']).suiteIds).toEqual([
      'runtime-jobs'
    ]);
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['src/jobs/queue.ts']).suiteIds).toEqual([
      'runtime-jobs'
    ]);
  });

  test('keeps planned Simulation, Experience, and Editor gaps explicit', () => {
    for (const path of [
      'src/animation/controller.ts',
      'src/input/actions.ts',
      'src/editor/document.ts'
    ]) {
      const route = routeChangedFiles(BENCHMARK_MANIFEST, [path]);
      expect(route.suiteIds).toEqual([]);
      expect(route.missingDomainIds).toHaveLength(1);
    }
  });

  test('routes Material-owned paths only to the dedicated material suite', () => {
    for (const path of [
      'engine/design/v2/04-rendering/03-material-system.md',
      'src/material/parameter-block.ts',
      'test/material/material-instance.test.ts',
      'test/benchmark/material-system.test.ts',
      'benchmark/material-system/scenarios.ts'
    ]) {
      expect(routeChangedFiles(BENCHMARK_MANIFEST, [path]).suiteIds).toEqual(['material-system']);
    }
  });

  test('routes shared Material rendering helpers to both semantic owners', () => {
    for (const path of [
      'src/rendering/material-bindings.ts',
      'src/rendering/material-cache.ts',
      'src/rendering/material-resolution.ts',
      'src/rendering/pipeline-resolver.ts'
    ]) {
      expect(routeChangedFiles(BENCHMARK_MANIFEST, [path]).suiteIds).toEqual([
        'material-system',
        'render-world'
      ]);
    }
  });

  test('keeps Shader and RenderWorld design paths with their dedicated suites', () => {
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['src/shader/layout.ts']).suiteIds).toEqual([
      'shader-system'
    ]);
    expect(
      routeChangedFiles(BENCHMARK_MANIFEST, ['engine/design/v2/04-rendering/01-render-world.md'])
        .suiteIds
    ).toEqual(['render-world']);
    expect(
      routeChangedFiles(BENCHMARK_MANIFEST, ['engine/design/v2/04-rendering/02-shader-system.md'])
        .suiteIds
    ).toEqual(['shader-system']);
  });
});

describe('framework command planning', () => {
  test('parses and deduplicates Git name-only output', () => {
    expect(parseChangedPaths('src/ecs/world.ts\r\nsrc/ecs/world.ts\n\nREADME.md\n')).toEqual([
      'README.md',
      'src/ecs/world.ts'
    ]);
  });

  test('renders the requested profile without a shell command string', () => {
    const suite = BENCHMARK_MANIFEST.suites.find(({ id }) => id === 'ecs');
    if (!suite) throw new Error('Expected the ECS suite.');

    expect(renderSuiteCommand(suite, 'standard')).toEqual({
      executable: 'vite-node',
      args: ['benchmark/cli.ts', '--profile', 'standard']
    });
  });

  test('renders exactly one material profile placeholder', () => {
    const suite = BENCHMARK_MANIFEST.suites.find(({ id }) => id === 'material-system');
    expect(suite).toBeDefined();
    if (!suite) return;

    expect(suite.command.args.filter((argument) => argument === '{profile}')).toHaveLength(1);
    expect(renderSuiteCommand(suite, 'nightly')).toEqual({
      executable: 'node',
      args: ['benchmark/material-system-runner.mjs', 'nightly']
    });
  });

  test('parses changed and all commands and rejects unknown options', () => {
    expect(
      parseFrameworkCliOptions([
        'changed',
        '--profile',
        'standard',
        '--file',
        'src/ecs/world.ts',
        '--dry-run'
      ])
    ).toEqual({
      command: 'changed',
      profile: 'standard',
      files: ['src/ecs/world.ts'],
      dryRun: true
    });
    expect(parseFrameworkCliOptions(['all'])).toEqual({
      command: 'all',
      profile: 'smoke',
      dryRun: false
    });
    expect(() => parseFrameworkCliOptions(['changed', '--quick'])).toThrow(
      'Unknown benchmark framework option'
    );
  });

  test('runs changed rendering work through the registered suite', async () => {
    const execute = vi.fn();

    const result = await runBenchmarkPlan(
      BENCHMARK_MANIFEST,
      {
        mode: 'changed',
        profile: 'smoke',
        files: ['src/rendering/render-graph.ts'],
        dryRun: false
      },
      execute
    );
    expect(result.suiteIds).toEqual(['render-world']);
    expect(execute).toHaveBeenCalled();
  });

  test('runs only routed suites and supports dry-run planning', async () => {
    const execute = vi.fn().mockResolvedValue({ stdout: 'artifact.json\n', stderr: '' });

    const result = await runBenchmarkPlan(
      BENCHMARK_MANIFEST,
      { mode: 'changed', profile: 'smoke', files: ['src/ecs/world.ts'], dryRun: true },
      execute
    );

    expect(result.suiteIds).toEqual(['ecs']);
    expect(result.commands).toEqual([
      {
        executable: 'vite-node',
        args: ['benchmark/cli.ts', '--profile', 'smoke']
      }
    ]);
    expect(execute).not.toHaveBeenCalled();
  });
});
