import type { BenchmarkManifest } from './types';

export const BENCHMARK_MANIFEST: BenchmarkManifest = Object.freeze({
  domains: Object.freeze([
    Object.freeze({
      id: 'runtime',
      description: 'App schedules, events, time, and other frame-critical runtime paths.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/01-foundation/03-time-events-commands.md',
        'engine/design/v2/02-runtime/01-app-plugin.md',
        'engine/design/v2/02-runtime/04-dynamic-plugin-runtime.md',
        'src/app/',
        'src/events/'
      ])
    }),
    Object.freeze({
      id: 'ecs',
      description: 'ECS storage, queries, relations, change tracking, and transform data paths.',
      pathPrefixes: Object.freeze(['engine/design/v2/02-runtime/02-ecs-world.md', 'src/ecs/'])
    }),
    Object.freeze({
      id: 'transform',
      description: 'Transform propagation and extraction snapshot paths.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/01-foundation/02-math-transform.md',
        'engine/design/v2/02-runtime/02-ecs-world.md',
        'engine/requirements.md',
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
        'engine/design/v2/03-platform/01-host-window-surface.md',
        'engine/design/v2/03-platform/02-rhi-contract.md',
        'engine/design/v2/03-platform/03-webgpu-backend.md',
        'engine/design/v2/03-platform/04-webgl2-backend.md',
        'src/platform/browser/',
        'src/platform/browser-graphics',
        'src/rhi/'
      ])
    }),
    Object.freeze({
      id: 'rendering',
      description:
        'RenderWorld, shader, material, RenderGraph, visibility, lighting, and post paths.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/10-quality/01-feature-policy.md',
        'engine/design/v2/04-rendering/',
        'src/feature-policy/',
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
      id: 'simulation-vfx',
      description:
        'VFX effect/emitter execution plans, parameter sampling, and vertex-analytic/GPU simulation paths.',
      pathPrefixes: Object.freeze(['engine/design/v2/06-simulation/02-particle-vfx.md'])
    }),
    Object.freeze({
      id: 'vfx-runtime',
      description:
        'Production VFX simulation, compute shaders, GPU storage buffers, and emitter runtime.',
      pathPrefixes: Object.freeze(['src/vfx/'])
    }),
    Object.freeze({
      id: 'animation',
      description:
        'Animation targets, tracks, curve evaluation, blending, and skeletal/morph skinning paths.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/06-simulation/01-animation.md',
        'src/animation/'
      ])
    }),
    Object.freeze({
      id: 'physics',
      description:
        'Physics fixed-step authority, Rapier adapter, colliders, character controllers, and query paths.',
      pathPrefixes: Object.freeze(['engine/design/v2/06-simulation/03-physics.md', 'src/physics/'])
    }),
    Object.freeze({
      id: 'navigation',
      description: 'Crowd simulation, navmesh queries, spatial pathfinding, and avoidance paths.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/06-simulation/05-ai-navigation.md',
        'src/navigation/'
      ])
    }),
    Object.freeze({
      id: 'networking',
      description:
        'Networking replication, state sync, room sessions, matchmaking, and transport paths.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/06-simulation/04-networking.md',
        'engine/design/v2/06-simulation/06-session-room-matchmaking.md',
        'src/networking/',
        'src/session/'
      ])
    }),
    Object.freeze({
      id: 'experience',
      description: 'Input, UI/text, audio, picking, and user-facing interaction paths.',
      pathPrefixes: Object.freeze([
        'engine/design/v2/07-experience/',
        'src/input/',
        'src/ui/',
        'src/audio/',
        'src/picking/'
      ])
    }),
    Object.freeze({
      id: 'editor',
      description: 'Editor document, command, snapshot, picking, and large-scene workflows.',
      pathPrefixes: Object.freeze(['engine/design/v2/08-tooling/02-editor.md'])
    }),
    Object.freeze({
      id: 'editor-runtime',
      description:
        'Production Editor document state, undo/redo stacks, and UI tools implementation.',
      pathPrefixes: Object.freeze(['src/editor/'])
    })
  ]),
  suites: Object.freeze([
    Object.freeze({
      id: 'dynamic-plugin-runtime',
      description:
        'Dynamic plugin activation, last-good updates, reverse cleanup, and stale-message rejection.',
      domainIds: Object.freeze(['runtime']),
      pathPrefixes: Object.freeze([
        'benchmark/dynamic-plugin-runtime/',
        'benchmark/dynamic-plugin-runtime.bench.ts',
        'benchmark/dynamic-plugin-runtime-runner.mjs',
        'engine/design/v2/02-runtime/04-dynamic-plugin-runtime.md',
        'src/dynamic-plugins/',
        'test/benchmark/dynamic-plugin-runtime.test.ts',
        'test/dynamic-plugins/'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/dynamic-plugin-runtime-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'runtime-jobs',
      description:
        'Runtime schedule ordering and mixed-class job queue ordering with deterministic reference oracles.',
      domainIds: Object.freeze(['runtime', 'jobs']),
      pathPrefixes: Object.freeze([
        'benchmark/runtime-jobs.bench.ts',
        'benchmark/runtime-jobs-runner.mjs',
        'benchmark/runtime-jobs/',
        'engine/design/v2/01-foundation/03-time-events-commands.md',
        'engine/design/v2/02-runtime/01-app-plugin.md',
        'engine/design/v2/02-runtime/03-jobs-workers.md',
        'src/app/',
        'src/ecs/command-buffer.ts',
        'src/events/',
        'src/jobs/',
        'test/benchmark/runtime-jobs.test.ts'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/runtime-jobs-runner.mjs', '{profile}'])
      })
    }),
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
      id: 'transform-runtime',
      description:
        'Transform propagation and RenderTransformSnapshot matrix extraction with detached publication boundaries.',
      domainIds: Object.freeze(['transform']),
      pathPrefixes: Object.freeze([
        'benchmark/transform-runtime.bench.ts',
        'benchmark/transform-runtime-runner.mjs',
        'benchmark/transform-runtime-runner-guard.mjs',
        'benchmark/transform-runtime-scenario.ts',
        'engine/design/v2/01-foundation/02-math-transform.md',
        'engine/design/v2/02-runtime/02-ecs-world.md',
        'engine/requirements.md',
        'src/transform/',
        'test/benchmark/transform-runtime.test.ts',
        'test/transform/'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/transform-runtime-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'rhi',
      description: 'RHI validation, command recording, and submission baseline.',
      domainIds: Object.freeze(['rhi']),
      pathPrefixes: Object.freeze([
        'benchmark/rhi-command.bench.ts',
        'benchmark/rhi-command-runner.mjs',
        'engine/design/v2/03-platform/01-host-window-surface.md',
        'engine/design/v2/03-platform/02-rhi-contract.md',
        'engine/design/v2/03-platform/03-webgpu-backend.md',
        'engine/design/v2/03-platform/04-webgl2-backend.md',
        'src/platform/browser/',
        'src/platform/browser-graphics',
        'src/rhi/',
        'test/rhi/'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/rhi-command-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'feature-policy',
      description:
        'Capability, semantic, dependency, budget, and stable implementation selection with an independent decision oracle.',
      domainIds: Object.freeze(['rendering']),
      pathPrefixes: Object.freeze([
        'benchmark/feature-policy/',
        'benchmark/feature-policy-runner.mjs',
        'engine/design/v2/10-quality/01-feature-policy.md',
        'src/feature-policy/',
        'src/rendering/lighting/light-list-feature.ts',
        'test/feature-policy/',
        'test/feature-policy/light-list-build.test.ts',
        'test/benchmark/feature-policy.test.ts'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/feature-policy-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'render-world',
      description:
        'RenderWorld extraction, immutable revisions, identity mapping, and deterministic diff publishing.',
      domainIds: Object.freeze(['rendering']),
      pathPrefixes: Object.freeze([
        'benchmark/render-world.bench.ts',
        'benchmark/render-world/',
        'engine/design/v2/04-rendering/01-render-world.md',
        'src/rendering/',
        'test/rendering/',
        'test/benchmark/render-world.test.ts'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/render-world-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'shader-system',
      description:
        'WGSL and FluxSL authoring, reflection, backend cooking, ABI, variant, and cache paths.',
      domainIds: Object.freeze(['rendering']),
      pathPrefixes: Object.freeze([
        'benchmark/shader-system.bench.ts',
        'benchmark/shader-system/',
        'benchmark/shader-system-runner.mjs',
        'engine/design/v2/04-rendering/02-shader-system.md',
        'engine/design/v2/04-rendering/09-pipeline-layout-specialization.md',
        'engine/design/v2/05-assets-scene/06-render-artifact-package.md',
        'engine/design/v2/08-tooling/03-build-release.md',
        'src/rendering/pipeline/binding-layout-',
        'src/rendering/pipeline/layout-cache.ts',
        'src/rendering/pipeline/types/binding-layout-',
        'src/rendering/binding-layout-',
        'src/rendering/layout-cache.ts',
        'src/rendering/types/binding-layout-',
        'test/rendering/binding-layout-',
        'test/rendering/layout-cache.test.ts',
        'test/benchmark/shader-binding-layout.test.ts',
        'src/shader/',
        'test/shader/',
        'test/tooling/',
        'tools/naga-shader-validator/',
        'tools/shader-cooker/',
        'tools/vite/',
        'scripts/cook-wgsl-shader.ts',
        'scripts/check-runtime-shader-bundle.ts'
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
        'src/rendering/material/material-bindings.ts',
        'src/rendering/material/material-cache.ts',
        'src/rendering/material/material-resolution.ts',
        'src/rendering/pipeline/pipeline-resolver.ts',
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
    }),
    Object.freeze({
      id: 'render-graph',
      description:
        'RenderGraph hazards, culling, stable topology, lifetime planning, and deterministic compiler evidence.',
      domainIds: Object.freeze(['rendering']),
      pathPrefixes: Object.freeze([
        'benchmark/render-graph/',
        'benchmark/render-graph-runner.mjs',
        'engine/design/v2/04-rendering/04-render-graph.md',
        'src/render-graph/',
        'test/benchmark/render-graph.test.ts',
        'test/render-graph/'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/render-graph-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'camera-visibility',
      description:
        'Camera projection validation and deterministic CPU sphere/AABB frustum visibility.',
      domainIds: Object.freeze(['rendering']),
      pathPrefixes: Object.freeze([
        'benchmark/camera-visibility.bench.ts',
        'benchmark/camera-visibility-runner.mjs',
        'benchmark/camera-visibility/',
        'engine/design/v2/04-rendering/05-camera-visibility.md',
        'src/rendering/camera.ts',
        'src/rendering/camera/',
        'src/rendering/visibility.ts',
        'src/rendering/visibility/',
        'src/math/frustum.ts',
        'test/rendering/camera-visibility.test.ts',
        'test/rendering/spatial-index.test.ts',
        'test/benchmark/camera-visibility.test.ts'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/camera-visibility-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'lighting-shadow',
      description:
        'Deterministic CPU light-list assignment, bounded overflow, and independent scalar correctness evidence.',
      domainIds: Object.freeze(['rendering']),
      pathPrefixes: Object.freeze([
        'benchmark/lighting-shadow.bench.ts',
        'benchmark/lighting-shadow-runner.mjs',
        'benchmark/lighting-shadow/',
        'engine/design/v2/04-rendering/06-lighting-shadow.md',
        'src/rendering/lighting/',
        'test/rendering/lighting-shadow.test.ts',
        'test/benchmark/lighting-shadow.test.ts'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/lighting-shadow-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'asset-pipeline',
      description:
        'Asset demand merge, stable priority, budget admission, streaming scale, and package/cook planning baselines.',
      domainIds: Object.freeze(['assets']),
      pathPrefixes: Object.freeze([
        'benchmark/asset-pipeline.bench.ts',
        'benchmark/asset-pipeline-runner.mjs',
        'benchmark/asset-pipeline/',
        'engine/design/v2/05-assets-scene/',
        'src/assets/cook/',
        'tools/asset-cook/',
        'tools/asset-vfs/',
        'src/geometry/',
        'src/rendering/mesh/mesh-constants.ts',
        'src/rendering/mesh/mesh-prepare.ts',
        'src/rendering/mesh-constants.ts',
        'src/rendering/mesh-prepare.ts',
        'test/geometry/',
        'test/assets/cook-dependency-graph.test.ts',
        'test/assets/cook-transaction.test.ts',
        'test/assets/shader-recook-coordinator.test.ts',
        'test/tooling/filesystem-cook-artifact-store.test.ts',
        'test/tooling/filesystem-shader-source-watcher.test.ts',
        'test/tooling/native-wgsl-recook-adapter.test.ts',
        'test/tooling/indexeddb-vfs-provider.test.ts',
        'test/tooling/shader-source-change-bridge.test.ts',
        'test/rendering/mesh-prepare.test.ts',
        'test/benchmark/asset-pipeline.test.ts'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/asset-pipeline-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'simulation-vfx',
      description:
        'Simulation VFX vertex-analytic raw baseline and scalar reference determinism, spawn batches, and state oracle.',
      domainIds: Object.freeze(['simulation-vfx']),
      pathPrefixes: Object.freeze([
        'benchmark/simulation-vfx.bench.ts',
        'benchmark/simulation-vfx-runner.mjs',
        'benchmark/simulation-vfx/',
        'engine/design/v2/06-simulation/02-particle-vfx.md',
        'test/benchmark/simulation-vfx.test.ts'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/simulation-vfx-runner.mjs', '{profile}'])
      })
    }),
    Object.freeze({
      id: 'editor-workflow',
      description:
        'Editor document command batches, snapshot revision tracking, and state checksum baselines.',
      domainIds: Object.freeze(['editor']),
      pathPrefixes: Object.freeze([
        'benchmark/editor-workflow.bench.ts',
        'benchmark/editor-workflow-runner.mjs',
        'benchmark/editor-workflow/',
        'engine/design/v2/08-tooling/02-editor.md',
        'test/benchmark/editor-workflow.test.ts'
      ]),
      command: Object.freeze({
        executable: 'node',
        args: Object.freeze(['benchmark/editor-workflow-runner.mjs', '{profile}'])
      })
    })
  ])
});
