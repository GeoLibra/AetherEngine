import { describe, expect, test, vi } from 'vitest';
import { parseChangedPaths } from '../../benchmark/framework/git-changes';
import { parseFrameworkCliOptions } from '../../benchmark/framework/cli-options';
import { BENCHMARK_MANIFEST } from '../../benchmark/framework/manifest';
import { routeChangedFiles } from '../../benchmark/framework/routing';
import { renderSuiteCommand, runBenchmarkPlan } from '../../benchmark/framework/runner';
import type { BenchmarkManifest } from '../../benchmark/framework/types';
import { validateManifest } from '../../benchmark/framework/validation';

function resolveAffectedBenchmarkSuites(changedFiles: readonly string[]): readonly string[] {
  return routeChangedFiles(BENCHMARK_MANIFEST, changedFiles).suiteIds;
}

describe('benchmark manifest', () => {
  test('registers ECS while keeping future performance domains visible', () => {
    const result = validateManifest(BENCHMARK_MANIFEST);

    expect(result.errors).toEqual([]);
    expect(result.uncoveredDomainIds).not.toContain('rendering');
    expect(result.uncoveredDomainIds).not.toContain('ecs');
    expect(result.uncoveredDomainIds).not.toContain('transform');
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

  test('routes transform extraction changes only to the dedicated matrix snapshot suite', () => {
    const route = routeChangedFiles(BENCHMARK_MANIFEST, ['src/transform/runtime.ts']);

    expect(route.domainIds).toEqual(['transform']);
    expect(route.suiteIds).toEqual(['transform-runtime']);
    expect(route.missingDomainIds).toEqual([]);
  });

  test('routes the transform design and requirement contract to its dedicated suite', () => {
    for (const path of [
      'engine/design/v2/01-foundation/02-math-transform.md',
      'engine/requirements.md'
    ]) {
      const route = routeChangedFiles(BENCHMARK_MANIFEST, [path]);
      expect(route.domainIds).toEqual(['transform']);
      expect(route.suiteIds).toEqual(['transform-runtime']);
      expect(route.missingDomainIds).toEqual([]);
    }
  });

  test('routes the ECS transform contract through both ECS and transform extraction suites', () => {
    const route = routeChangedFiles(BENCHMARK_MANIFEST, [
      'engine/design/v2/02-runtime/02-ecs-world.md'
    ]);

    expect(route.domainIds).toEqual(['ecs', 'transform']);
    expect(route.suiteIds).toEqual(['ecs', 'transform-runtime']);
    expect(route.missingDomainIds).toEqual([]);
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
    const shaderSuite = BENCHMARK_MANIFEST.suites.find((suite) => suite.id === 'shader-system');
    expect(shaderSuite?.description).toBe(
      'WGSL and FluxSL authoring, reflection, backend cooking, ABI, variant, and cache paths.'
    );
    expect(
      routeChangedFiles(BENCHMARK_MANIFEST, ['engine/design/v2/04-rendering/02-shader-system.md'])
        .suiteIds
    ).toEqual(['shader-system']);
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['src/shader/compiler.ts']).suiteIds).toEqual([
      'shader-system'
    ]);

    expect(
      resolveAffectedBenchmarkSuites(['engine/design/v2/08-tooling/03-build-release.md'])
    ).toEqual(['shader-system']);

    expect(resolveAffectedBenchmarkSuites(['tools/naga-shader-validator/src/main.rs'])).toEqual([
      'shader-system'
    ]);
    expect(resolveAffectedBenchmarkSuites(['tools/naga-shader-validator/'])).toEqual([
      'shader-system'
    ]);

    expect(
      resolveAffectedBenchmarkSuites([
        'engine/design/v2/05-assets-scene/06-render-artifact-package.md'
      ])
    ).toEqual(expect.arrayContaining(['shader-system', 'asset-pipeline']));
  });

  test('routes Runtime and Jobs to their shared deterministic suite', () => {
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['src/app/schedule.ts']).suiteIds).toEqual([
      'runtime-jobs'
    ]);
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['src/jobs/queue.ts']).suiteIds).toEqual([
      'runtime-jobs'
    ]);
    expect(routeChangedFiles(BENCHMARK_MANIFEST, ['src/ecs/command-buffer.ts']).suiteIds).toEqual([
      'ecs',
      'runtime-jobs'
    ]);
  });

  test('routes browser graphics contracts and adapters to the RHI suite', () => {
    for (const path of [
      'engine/design/v2/03-platform/01-host-window-surface.md',
      'engine/design/v2/03-platform/02-rhi-contract.md',
      'engine/design/v2/03-platform/03-webgpu-backend.md',
      'engine/design/v2/03-platform/04-webgl2-backend.md',
      'src/rhi/webgpu/browser/device-port.ts',
      'src/rhi/webgl2/browser/context-port.ts'
    ]) {
      expect(routeChangedFiles(BENCHMARK_MANIFEST, [path]).suiteIds).toEqual(['rhi']);
    }
  });

  test('routes VFX and Editor design paths to their registered baseline suites and keeps Runtime, Animation, Physics, Navigation, Networking, Experience gaps explicit', () => {
    // Design documents route to registered baseline suites
    expect(
      routeChangedFiles(BENCHMARK_MANIFEST, ['engine/design/v2/06-simulation/02-particle-vfx.md'])
        .suiteIds
    ).toEqual(['simulation-vfx']);

    expect(
      routeChangedFiles(BENCHMARK_MANIFEST, ['engine/design/v2/08-tooling/02-editor.md']).suiteIds
    ).toEqual(['editor-workflow']);

    // Production runtime paths remain blocked until production suites are ready
    const vfxRuntime = routeChangedFiles(BENCHMARK_MANIFEST, ['src/vfx/emitter.ts']);
    expect(vfxRuntime.suiteIds).toEqual([]);
    expect(vfxRuntime.missingDomainIds).toEqual(['vfx-runtime']);

    const editorRuntime = routeChangedFiles(BENCHMARK_MANIFEST, ['src/editor/document.ts']);
    expect(editorRuntime.suiteIds).toEqual([]);
    expect(editorRuntime.missingDomainIds).toEqual(['editor-runtime']);

    // Real simulation & networking design docs and source paths
    const animRoute = routeChangedFiles(BENCHMARK_MANIFEST, [
      'engine/design/v2/06-simulation/01-animation.md',
      'src/animation/controller.ts'
    ]);
    expect(animRoute.suiteIds).toEqual([]);
    expect(animRoute.missingDomainIds).toEqual(['animation']);

    const physRoute = routeChangedFiles(BENCHMARK_MANIFEST, [
      'engine/design/v2/06-simulation/03-physics.md',
      'src/physics/world.ts'
    ]);
    expect(physRoute.suiteIds).toEqual([]);
    expect(physRoute.missingDomainIds).toEqual(['physics']);

    const navRoute = routeChangedFiles(BENCHMARK_MANIFEST, [
      'engine/design/v2/06-simulation/05-ai-navigation.md',
      'src/navigation/navmesh.ts'
    ]);
    expect(navRoute.suiteIds).toEqual([]);
    expect(navRoute.missingDomainIds).toEqual(['navigation']);

    const netRoute = routeChangedFiles(BENCHMARK_MANIFEST, [
      'engine/design/v2/06-simulation/04-networking.md',
      'engine/design/v2/06-simulation/06-session-room-matchmaking.md',
      'src/networking/transport.ts'
    ]);
    expect(netRoute.suiteIds).toEqual([]);
    expect(netRoute.missingDomainIds).toEqual(['networking']);

    const expRoute = routeChangedFiles(BENCHMARK_MANIFEST, [
      'engine/design/v2/07-experience/01-input.md',
      'src/input/actions.ts'
    ]);
    expect(expRoute.suiteIds).toEqual([]);
    expect(expRoute.missingDomainIds).toEqual(['experience']);
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

  test('routes FeaturePolicy design, source, fixtures, and benchmarks to its dedicated suite', () => {
    for (const path of [
      'engine/design/v2/10-quality/01-feature-policy.md',
      'src/feature-policy/resolver.ts',
      'test/feature-policy/resolver.test.ts',
      'test/benchmark/feature-policy.test.ts',
      'benchmark/feature-policy/scenarios.ts'
    ]) {
      const route = routeChangedFiles(BENCHMARK_MANIFEST, [path]);
      expect(route.suiteIds).toEqual(['feature-policy']);
      expect(route.missingDomainIds).toEqual([]);
    }
    expect(
      routeChangedFiles(BENCHMARK_MANIFEST, ['src/rendering/lighting/light-list-feature.ts'])
        .suiteIds
    ).toEqual(['feature-policy', 'lighting-shadow', 'render-world']);
  });

  test('routes shared Material rendering helpers to both semantic owners', () => {
    for (const path of [
      'src/rendering/material/material-bindings.ts',
      'src/rendering/material/material-cache.ts',
      'src/rendering/material/material-resolution.ts',
      'src/rendering/pipeline/pipeline-resolver.ts',
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
