# Benchmark Development Framework

Benchmark is a normal development deliverable for performance-sensitive engine work. It is separate from unit and contract tests:

- `test/` proves deterministic behavior, errors, invariants, and correctness.
- `benchmark/` proves workload scaling, throughput/latency, memory or allocation behavior, and architecture tradeoffs.

Every timed scenario must check its correctness oracle before it reports samples. A passing benchmark never replaces a correctness test.

## How development is triggered

The typed registry in [`framework/manifest.ts`](./framework/manifest.ts) maps design/source paths to performance domains and maps implemented domains to executable suites.

At the start of a subsystem change, the Agent routes the target design or planned source path:

```sh
pnpm bench changed --file engine/design/v2/04-rendering/01-render-world.md --dry-run
```

There are three possible outcomes:

1. A suite is selected: update it when the workload or hot path changes.
2. The domain is recognized but has no suite: add a minimal meaningful suite before production implementation.
3. No domain matches: document `not performance-sensitive` for a non-trivial change that still appears to touch a scaling path, or add the missing domain mapping.

The framework detects, requires, selects, and runs benchmarks. The development Agent still authors the hypothesis, fixture, oracle, baseline, metrics, and interpretation; those cannot be inferred safely from filenames.

## Commands

```sh
# Validate IDs, domain references, and command definitions.
pnpm bench validate

# Route current staged, unstaged, and untracked files and run matching smoke suites.
pnpm bench changed

# Inspect routing without executing timing work.
pnpm bench changed --file src/ecs/world.ts --dry-run

# Compare a branch and include current working-tree changes.
pnpm bench changed --base origin/main

# Run every registered suite with a selected profile.
pnpm bench all --profile standard
```

`pnpm bench validate` reports planned domains that do not have suites yet, but does not fail solely because future work is unimplemented. `pnpm bench changed` does fail when the current change touches one of those domains. This permits incremental engine development without allowing a new Rendering/RHI/Jobs path to silently ship without performance coverage.

## Adding a suite

Create focused files under `benchmark/`, then add one `BenchmarkSuiteDefinition` to `framework/manifest.ts`:

```ts
{
  id: 'rendering',
  description: 'RenderWorld extraction and RenderGraph build/compile workloads.',
  domainIds: ['rendering'],
  pathPrefixes: ['benchmark/rendering/'],
  command: {
    executable: 'pnpm',
    args: ['run', 'bench:rendering', '--', '--profile', '{profile}']
  }
}
```

The suite command must accept `smoke`, `standard`, and `nightly`. Use executable/argument arrays; never add shell fragments to the manifest.

The first scenario for a domain must define:

- performance hypothesis and decision it can change;
- deterministic workload, seed, and scale axes;
- correctness oracle and structural counters;
- raw/reference baseline or a written reason it is not meaningful;
- warmup and retained raw samples;
- environment metadata and artifact schema;
- interpretation rules for implementation, API-boundary, algorithm, or architecture overhead.

## Rendering example

The `rendering` domain is covered by dedicated RenderWorld and Shader System suites. A new rendering slice must extend the appropriate suite—or register a new one—then add correctness tests, implement the slice, and run `pnpm bench changed` before completion.

Do not build all Rendering benchmarks up front. Each implementation slice owns the scenario needed to validate its actual performance hypothesis.
