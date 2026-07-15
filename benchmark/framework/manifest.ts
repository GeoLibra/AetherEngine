import type { BenchmarkManifest } from './types';

export const BENCHMARK_MANIFEST: BenchmarkManifest = Object.freeze({
  domains: Object.freeze([
    Object.freeze({
      id: 'runtime',
      description: 'App schedules, events, time, and other frame-critical runtime paths.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/01-foundation/03-time-events-commands.md',
        'engine/design/v2/02-runtime/01-app-plugin.md',
        'src/app/',
        'src/events/'
      ])
    }),
    Object.freeze({
      id: 'ecs',
      description: 'ECS storage, queries, relations, change tracking, and transform data paths.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/02-runtime/02-ecs-world.md',
        'src/ecs/',
        'src/transform/'
      ])
    }),
    Object.freeze({
      id: 'jobs',
      description: 'Worker scheduling, queues, transfer, cancellation, and commit budgets.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/02-runtime/03-jobs-workers.md',
        'src/jobs/'
      ])
    }),
    Object.freeze({
      id: 'rhi',
      description: 'RHI validation, command lowering, uploads, state caches, and submission.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/03-platform/02-rhi-contract.md',
        'engine/design/v2/03-platform/03-webgpu-backend.md',
        'engine/design/v2/03-platform/04-webgl2-backend.md',
        'src/rhi/'
      ])
    }),
    Object.freeze({
      id: 'rendering',
      description: 'RenderWorld, shader, material, RenderGraph, visibility, lighting, and post paths.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/04-rendering/',
        'src/rendering/',
        'src/shader/',
        'src/material/'
      ])
    }),
    Object.freeze({
      id: 'assets',
      description: 'Asset import, cook, streaming, scene, prefab, and geometry processing.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/05-assets-scene/',
        'src/assets/',
        'src/scene/'
      ])
    }),
    Object.freeze({
      id: 'editor',
      description: 'Editor document, command, snapshot, picking, and large-scene workflows.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/06-editor/',
        'src/editor/'
      ])
    })
  ]),
  suites: Object.freeze([
    Object.freeze({
      id: 'ecs',
      description: 'ECS raw baselines, Aether diagnostic lanes, and competitor adapters.',
      domainIds: Object.freeze(['ecs']),
      pathPrefixes: Object.freeze([
        'benchmark/adapters/',
        'benchmark/cli.ts',
        'benchmark/ecs-harness-design.md',
        'benchmark/harness/',
        'benchmark/profiles.ts',
        'benchmark/run.ts',
        'benchmark/scenarios/',
        'benchmark/worker.ts'
      ]),
      command: Object.freeze({
        executable: 'npm',
        args: Object.freeze(['run', 'bench:ecs', '--', '--profile', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'render-world',
      description: 'RenderWorld extraction, immutable revisions, identity mapping, and deterministic diff publishing.',
      domainIds: Object.freeze(['rendering']),
      pathPrefixes: Object.freeze([
        'benchmark/render-world.bench.ts',
        'engine/design/v2/04-rendering/01-render-world.md',
        'src/rendering/',
        'test/rendering/'
      ]),
      command: Object.freeze({
        executable: 'npm',
        args: Object.freeze(['run', 'bench:render-world', '--', '{profile}'])
      })
    })
  ])
});
