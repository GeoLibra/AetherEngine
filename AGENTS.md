# AGENTS.md

# AI Engineering Guardrails

This document defines the rules that AI agents must follow when changing the AetherEngine repository.

The goal is to keep the TypeScript engine core maintainable, design-driven, type-safe, and predictable for future AI-assisted changes.

---

# Core Principles

## 1. Design Documents Are the Source of Intent

Before implementing a subsystem, read `engine/requirements.md` for product scope and acceptance, `engine/design.md` for the current architecture summary, then start from `engine/design/README.md` and read the matching current document in `engine/design/v2/`.

Examples:

- App and plugin runtime: `engine/design/v2/02-runtime/01-app-plugin.md`
- ECS world and queries: `engine/design/v2/02-runtime/02-ecs-world.md`
- Rendering abstractions: `engine/design/v2/03-platform/02-rhi-contract.md` and `engine/design/v2/04-rendering/`

Use the design docs to understand public concepts and constraints. Use the existing `src/` code to decide the exact implementation style.

V2 documents may contain both normative contracts and explicitly labeled reference implementations. Preserve useful backend mappings, algorithm derivations, typed templates, and business use cases when revising docs; correct them to V2 boundaries instead of silently deleting them. A deferred V1 capability must have an explicit Proposed/Research/Optional destination in V2 and the migration matrix.

`engine/design/v1/` is a frozen historical snapshot. When maintaining code that has not yet migrated to V2, also read the matching V1 chapter and `engine/design/v2/appendices/v1-to-v2-matrix.md` so the current behavior and target behavior are both explicit. Reviews in `engine/reviews/` explain decisions but are not runtime contracts.

Do not silently expand scope into a later design document unless the user asks for it.

## 2. Simplicity First

Prefer:

- small classes and functions
- explicit names
- narrow public APIs
- focused modules with one reason to change
- behavior that is easy to test without a browser or GPU

Avoid:

- broad rewrites
- premature abstractions
- hidden global state
- clever scheduling, plugin, or registry behavior that is hard to reason about

## 3. Separation of Concerns

Keep these responsibilities separate:

- app lifecycle, plugins, schedules, services, and extensions: `src/app/`
- ECS world, resources, entities, components, and queries: `src/ecs/`
- built-in plugins: `src/plugins/`
- public package exports: `src/index.ts`
- behavior tests: `test/`
- current architecture and product intent: `engine/design/v2/`
- frozen historical design context: `engine/design/v1/`

Core runtime modules should not depend on future renderer/editor/asset implementations unless a stable token or extension point exists for that purpose.

## 4. Type Safety First

Prefer typed tokens, typed constructors, explicit interfaces, and generic APIs over stringly typed plumbing.

When adding registries or extension points:

- keep public tokens strongly typed
- avoid `any`; use `unknown` plus safe narrowing where needed
- make failure modes explicit with clear errors
- preserve useful type inference from caller code

## 5. Pure Function First

Scheduling, dependency ordering, resource lookup, serialization helpers, and data transforms should be pure where practical.

Pure functions must not:

- mutate caller-owned inputs
- read browser globals
- call external APIs
- write to storage

Side effects belong at lifecycle, plugin, service, or platform integration boundaries.

## 6. Architecture Before Code

Before non-trivial changes:

1. read this file
2. read the relevant `engine/design/v2/**/*.md` document and, for unmigrated code, the matching V1 chapter
3. inspect the current `src/` modules and tests
4. identify the existing responsibility boundaries
5. choose the smallest compatible implementation
6. add or update focused tests
7. classify whether the change affects a hot loop, scaling path, cache/index, allocation/copy path, scheduler/worker budget, backend lowering, or performance-selected fallback; if it does, read the matching benchmark requirements and `engine/design/v2/10-quality/03-performance-budgets.md`
8. route the planned design/source path through the benchmark manifest; if the matched performance domain has no suite, define and register that suite before writing production code
9. run the project verification commands

Do not rewrite stable workflows only to make the code look different.

## 7. Code Comments and Self-Documenting Code (代码即文档)

Code should be self-documenting through clear, domain-specific naming and precise TypeScript types. Supplement code with standardized English TSDoc/JSDoc comments and design rationale:

- **Contractual TSDoc Comments**: Document all exported interfaces, classes, resources, tokens, and public API methods with:
  - The operational responsibility of the symbol.
  - Coordinate space assumptions, units (e.g. meters, radians, normalized [0, 1]), and reference frames.
  - Parameter semantics, return values, and explicit exception/fail-fast scenarios (`@throws`).
- **Explain "Why" & Invariants**: Add code comments for non-obvious invariants, scheduling rules, lifecycle boundaries, fallback behavior, coordinate space transformations, and integration seams between subsystems. Explain why a design choice exists or what invariant must be preserved.
- **Avoid Trivial Narration**: Avoid comments that merely restate the code, narrate simple assignments, or decorate obvious TypeScript syntax.
- **Pure English**: Write all comments, documentation, and error messages in clear, idiomatic English.

## 8. Trust Boundaries and Fail-Fast Invariants

Validate data at trust boundaries, including public API input, platform/native ports, plugins, serialized data, and caller-owned mutable objects. Copy caller-owned data before retaining it; do not freeze the caller's object as a substitute for taking ownership.

Fail fast when an internal state guaranteed by types, validated construction, or lifecycle ordering is missing or inconsistent. Establish an invariant once at the owning boundary, encode it in the resulting type or structure, and let internal consumers trust it; do not repeat defensive null/undefined checks at every use site. Do not use a default value, optional chaining, silent return, empty object/collection, or immutable wrapper to conceal a state that the design declares impossible. An intentional fallback is allowed only when the design contract defines it; the selected fallback and reason must be explicit, observable, and tested.

Use `Object.freeze` for published immutable snapshots, stable shared identities, and values crossing ownership, asynchronous, or submission boundaries when runtime enforcement has clear value. Private temporaries and hot-path records default to owner-controlled mutation or TypeScript `readonly`; do not freeze them mechanically. `Object.freeze` is shallow and does not replace defensive copying or nested ownership decisions.

---

# File Structure Rules

Recommended library layout:

```txt
src/
  app/              # App lifecycle, schedules, plugins, service and extension registries
  ecs/              # World, resources, entities, components, queries, change tracking
  plugins/          # Built-in plugins composed through the App API
  index.ts          # Public package exports only
test/               # Vitest behavior and regression tests
benchmark/          # Reproducible performance scenarios, baselines, adapters, and harness code
engine/design/      # Versioned subsystem design documents; V2 is current
```

Responsibilities:

| File area                  | Responsibility                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `src/app/*.ts`             | App runtime, plugin API, schedule ordering, service/extension registries                          |
| `src/ecs/*.ts`             | ECS storage, resources, entities, components, queries, change detection                           |
| `src/plugins/*.ts`         | Built-in plugins that register resources, systems, services, or extensions                        |
| `src/index.ts`             | Stable public exports; no implementation logic                                                    |
| `test/*.test.ts`           | User-visible behavior, ordering, lifecycle, type-facing runtime contracts                         |
| `benchmark/`               | Reproducible performance scenarios, baselines, adapters, harness code, and non-generated profiles |
| `engine/design/v2/**/*.md` | Current design intent and implementation requirements                                             |
| `engine/design/v1/*.md`    | Frozen historical design context; do not extend                                                   |

### Constants, Types, and Pure Functions Separation

Prioritize extracting constants, TypeScript type definitions, and pure functions into their own dedicated files (e.g., `constants.ts`, `types.ts`, `utils.ts`) rather than keeping them co-located in the same file with stateful classes or subsystems. This maximizes reusability, simplifies testing, and prevents circular imports.

---

# File Size and Directory Density Limits

These limits apply to source code and test files. They do not apply to architecture, requirements, review, or other Markdown documentation.

Preferred code limits:

- TypeScript/JavaScript source file <= 500 lines
- class <= 250 lines
- pure utility function <= 100 lines
- test file <= 400 lines
- directory flat source files <= 10 to 12 files

### Directory Density & Subsystem Clustering Rules

1. **Directory Flat File Cap**:
   - A single directory should avoid flatly accumulating more than **10 ~ 12 source files**.
2. **Subsystem Clustering Threshold**:
   - When a subsystem evolves multiple distinct, cohesive responsibilities (e.g., _command recording & replay_, _state machine tracking & caching_, _pipeline compilation & binding fusion_, _resource allocation & uploads_), **do not keep flat files in the module root**. Proactively cluster them into focused functional subdirectories (e.g., `commands/`, `state/`, `pipeline/`, `resources/`).
3. **Complexity-Driven Hierarchy (Avoid Mechanical Flatness)**:
   - Module directory structure must reflect **internal domain complexity**, not superficial symmetry with simpler sibling backends. Modules that emulate stateless explicit APIs on stateful drivers (like WebGL2) naturally require deeper subsystem modularity than thin pass-through layers (like WebGPU).
4. **Subsystem Architecture README**:
   - Complex multi-subdirectory subsystems must maintain a root `README.md` documenting:
     - Architecture overview and design philosophy.
     - Subdirectory responsibility table.
     - Data flow and lifecycle sequences (Mermaid).
     - Core fail-fast invariants and error boundaries.

When a file or directory exceeds these limits, prefer extracting:

- shared types into a focused module (`types/`)
- pure helpers into small utility files near their subsystem
- distinct functional domains into subdirectories with `index.ts` exports
- built-in plugin behavior into `src/plugins/`
- independent behavior tests into separate test files

Incremental extraction is preferred over a large rewrite.

Design documents under `engine/design/` have no fixed line limit. Their priorities are contract completeness, internal consistency, navigability, and preservation of necessary invariants, algorithms, examples, backend mappings, failure behavior, performance requirements, and acceptance criteria.

Split a design document only when the resulting documents have clear, independently owned subsystem boundaries. Never split, summarize, or omit technical content merely to satisfy a line-count target. A long but cohesive design contract is preferable to a shorter document that leaves implementation decisions implicit.

---

# Runtime and API Rules

## App and Plugins

Plugins should:

- expose a stable `name`
- declare dependencies explicitly
- register systems, resources, services, or extensions through `App`
- keep build-time side effects minimal and deterministic

Plugins should not:

- reach into unrelated private internals
- rely on global singletons
- register renderer/editor/asset behavior without a token or extension point

## Schedules and Systems

Schedule behavior must remain deterministic.

When changing schedule ordering:

- preserve `before` and `after` semantics
- keep cycle detection explicit
- keep async system support
- add tests for ordering and failure cases

## Services and Extensions

Services are for scoped dependency lookup. Extensions are for enumerable contributions.

Use services when a plugin needs exactly one dependency for a scope. Use extensions when many plugins can contribute to the same point.

Do not use services or extensions as a dumping ground for unrelated global state.

## ECS Boundaries

The ECS implementation should stay independent from renderer, editor, asset, and platform code.

Renderer/editor integrations should consume ECS state through public APIs, resources, services, or extension points rather than private data structures.

## Shaders and Materials Single Source of Truth (WGSL 唯一事实来源，禁止双重实现)

WGSL (and the resulting cooked runtime shader artifacts) is the single source of truth for rendering algorithms, material surfaces, lighting equations, and shading logic.

When authoring or modifying materials and shaders:

- **Do not author parallel TypeScript CPU evaluators** (such as `*-surface.ts` or `evaluate*Surface` functions) for material or shader algorithms. Materials in TypeScript manage parameters, schemas, and resource bindings; they do not maintain duplicate CPU rasterization or surface shading pipelines.
- **Do not write unit tests that test a TypeScript duplicate of a shader against itself.** Tests asserting material algorithm correctness must follow the 4-tier verification hierarchy:
  1. **Structural Contract Tests**: Inspect WGSL and cooked GLSL ES artifacts directly to assert binding reflection, uniform field offsets, channel composition formulas (e.g. baseColor, metallic, roughness, normal decode, occlusion, emissive), numerical clamps (e.g. roughness floor), and coverage discard conditions.
  2. **Offscreen GPU / Pass Execution**: Execute compute shaders or headless offscreen render passes on WebGPU/headless GPU to read back buffers/textures and assert numeric semantics within declared tolerances.
  3. **Visual Golden Tests**: Assert end-to-end rendered conformance across WebGPU and WebGL2 backends using deterministic image snapshots.
  4. **Minimal Mathematical Oracles Only**: Analytical oracles in `benchmark/` or `test/` are strictly limited to pure, self-contained mathematical equations (such as `evaluateCookTorranceDirect` for single-sample direct BRDF verification) to validate numerical convergence and scale characteristics; they must never duplicate full multi-texture surface shaders.

---

# Constants and Magic Values

Extract repeated labels, lifecycle stage lists, token names, and default options into clearly named constants near the subsystem that owns them.

Avoid hardcoding the same stage name, scope name, or token prefix in multiple modules.

### Constants, Enums, and String Types Design Guidelines

1. **Avoid TypeScript Traditional `enum`**:
   - Do not use TypeScript traditional `enum Foo { ... }`.
   - Rationale: They generate runtime IIFE closure boilerplate, impede clean tree-shaking, introduce unnecessary serialization/deserialization mapping layers, and create impedance mismatches with standard WebGPU/WebGL APIs.

2. **WebGPU / Web Standards / Closed Variants (String Literal Unions)**:
   - For native WebGPU/WebGL contracts, platform interfaces, and closed discriminator tags (e.g. `RHIBackend`, `GPUCompareFunction`, `kind: 'buffer' | 'texture'`), use pure TypeScript string literal union types.
   - Rationale: Compile-time type checking and IDE autocomplete with zero runtime overhead, matching browser and WebGPU specifications directly without conversion layers.

3. **Runtime Sets and Named Constant Dictionaries (`as const` Objects)**:
   - When constants require namespace access (to prevent typos and support symbol refactoring) or runtime iteration/lookup (e.g. `CoreSchedule`, `LifecycleDiagnosticCode`, `LIGHT_KIND`), define a frozen `as const` object and derive its type:
     ```ts
     export const CoreSchedule = Object.freeze({
       Startup: 'Startup',
       Update: 'Update',
       Render: 'Render'
     } as const);
     export type CoreSchedule = (typeof CoreSchedule)[keyof typeof CoreSchedule];
     ```

4. **Extensible Unions with Autocomplete Preservation (`(string & {})` idiom)**:
   - When a parameter accepts built-in standard values but also permits custom extension strings (e.g., custom plugin schedule stages in `ScheduleLabel`), compose the standard `as const` type with `(string & {})`:
     ```ts
     export type ScheduleLabel = CoreSchedule | (string & {});
     ```
   - **Never** write `CoreSchedule | string`, as TypeScript's compiler will widen the entire type to `string`, destroying IDE autocomplete and discoverability for built-in constants.

5. **Typed Tokens Over String Plumbing**:
   - For resources, services, relations, and platform capabilities, use strongly-typed tokens (`ServiceToken<T>`, `ResourceToken<T>`, `defineRelation(...)`) rather than string-based lookups.

---

# Refactor Rules

Refactors must be behavior-preserving unless the user asks for behavior changes.

Prefer:

- small extractions
- stable public exports
- typed module boundaries
- tests around lifecycle and ordering behavior

Avoid:

- changing public API names casually
- introducing circular imports
- coupling core runtime code to browser-only APIs without fallback behavior
- implementing future design-doc features before their turn

### No Backward-Compatibility Residue (重构即完全覆盖，不留兼容残留)

The engine core is under active pre-release development and has not launched to external consumers. When refactoring APIs, types, shaders, or subsystem architecture:

- **Do not introduce or retain backward-compatibility shims, legacy alias exports, or duplicate symbols**:
  - Never retain deprecated aliases (e.g. `export const FOO_LEGACY = FOO;`, `export const FOO_GENERATED_ARTIFACT = FOO_ARTIFACT;`) or obsolete parameter overloads unless explicitly requested by the user.
  - Never leave dead callback surfaces (e.g. `publicContext()`, unused helper methods) or obsolete wrapper types behind when switching to a typed or revised API model.
- **Refactoring means complete, in-place migration (重构即完全覆盖)**:
  - Migrate all internal call sites, tests, benchmarks, docs, recipes, and barrel exports to the canonical contract in the same change.
  - Delete superseded symbols, obsolete types, generator options, and transitional adapters immediately.

---

# Performance Evidence

Add or update a benchmark when a change introduces or modifies a hot loop, bulk scan, storage layout, cache, index, pool, allocation/copy path, serializer, upload path, scheduler/worker queue, command lowering, or performance-selected fallback.

The repository-wide trigger is `benchmark/framework/manifest.ts`. At the start of non-trivial subsystem work, run a dry route for the target design or planned source path, for example:

```sh
npm run bench:changed -- --file engine/design/v2/04-rendering/01-render-world.md --dry-run
```

If the command reports a missing domain suite, the change is not ready for production implementation. Add the suite registration, raw/reference baseline, deterministic correctness oracle, and first representative scenario as part of the same development work. Do not bypass a missing suite by omitting the path, moving timing into `test/`, or describing performance only in prose.

Before implementation, the matching design or goal must state:

- the performance hypothesis
- deterministic workload and scale axes
- correctness oracle
- metrics and structural counters
- raw or competing baseline where meaningful
- the evidence required to keep, optimize, or revise the design

Unit tests do not substitute for benchmarks. Put deterministic correctness and structural invariants in `test/`; put warmup, repeated samples, scale trends, memory/throughput measurements, and comparisons in `benchmark/`. Share deterministic fixtures and correctness oracles where useful.

For a performance-sensitive change, run the relevant benchmark smoke profile before completion. A performance claim additionally requires a standard-profile artifact with environment metadata and raw samples. Wall-clock timing from an uncontrolled developer machine is not a default PR hard gate; checksum failures, invalid artifacts, unsupported semantic weakening, and deterministic counter regressions may fail immediately.

The development Agent writes or updates semantic benchmark scenarios; the framework does not synthesize workloads from implementation code. `npm run bench:validate` validates the registry, `npm run bench:changed` discovers and runs suites affected by the working-tree diff, and `npm run bench:all -- --profile standard` runs every registered suite when broader evidence is required.

Do not claim “high performance”, “low overhead”, “zero allocation”, “incremental”, or a performance improvement without corresponding evidence. If the result misses the hypothesis, report whether evidence points to implementation overhead, the public boundary, the algorithm, or the architecture; do not weaken required semantics to improve the number.

---

# Verification

Run these before declaring work complete:

```sh
npm run typecheck
npm test
npm run build
npm run bench:validate
npm run bench:changed
```

`bench:changed` is a no-op for unrelated changes, runs the smoke profile by default for registered domains, and fails when a changed performance domain lacks a suite. For performance-sensitive changes, report the suite, profile, environment, and artifact path. Do not make uncontrolled wall-clock timing a hard gate.

For browser, renderer, editor, or visual changes, also run the relevant local app or browser verification flow and state what was checked.

If a verification command cannot run, state why clearly.

---

# Git Hygiene

- Do not revert user changes unless explicitly asked.
- Keep unrelated work out of commits.
- Prefer separate commits for unrelated concerns.
- Before committing, inspect `git status --short` and the staged diff.
- Do not commit generated build output unless the repository convention or user request requires it.
