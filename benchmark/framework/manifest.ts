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
      pathPrefixes: Object.freeze(['engine/design/v2/02-runtime/03-jobs-workers.md', 'src/jobs/'])
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
      description:
        'RenderWorld, shader, material, RenderGraph, visibility, lighting, and post paths.',
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
      pathPrefixes: Object.freeze(['engine/design/v2/06-editor/', 'src/editor/'])
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
        executable: 'vite-node',
        args: Object.freeze(['benchmark/cli.ts', '--profile', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'rhi',
      description: 'RHI validation, command recording, and submission baseline.',
      domainIds: Object.freeze(['rhi']),
      pathPrefixes: Object.freeze([
        'benchmark/rhi-command.bench.ts',
        'benchmark/rhi-command-runner.mjs',
        'src/rhi/',
        'test/rhi/'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/rhi-command-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'render-world',
      description:
        'RenderWorld extraction, immutable revisions, identity mapping, and deterministic diff publishing.',
      domainIds: Object.freeze(['rendering']),
      pathPrefixes: Object.freeze([
        'benchmark/render-world.bench.ts',
        'engine/design/v2/04-rendering/01-render-world.md',
        'src/rendering/',
        'test/rendering/'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/render-world-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'shader-system',
      description: 'FluxSL source closure, typed parsing, ABI reflection, variant and cache paths.',
      domainIds: Object.freeze(['rendering']),
      pathPrefixes: Object.freeze([
        'benchmark/shader-system.bench.ts',
        'benchmark/shader-system-runner.mjs',
        'engine/design/v2/04-rendering/02-shader-system.md',
        'src/shader/',
        'test/shader/'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/shader-system-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'material-system',
      description:
        'Material parameter edits/uploads, technique and render-state resolution, canonical identities, and generation-safe cache behavior.',
      domainIds: Object.freeze(['rendering']),
      pathPrefixes: Object.freeze([
        'benchmark/material-system/',
        'benchmark/material-system-runner.mjs',
        'engine/design/v2/04-rendering/03-material-system.md',
        'src/material/',
        'src/rendering/material-bindings.ts',
        'src/rendering/material-cache.ts',
        'src/rendering/material-resolution.ts',
        'src/rendering/pipeline-resolver.ts',
        'test/material/',
        'test/benchmark/material-system.test.ts'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/material-system-runner.mjs', '{profile}'])
      })
    })
  ])
});
