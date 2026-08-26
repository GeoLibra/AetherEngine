# RenderGraph Subsystem

RenderGraph separates declarative render work from physical RHI execution. Systems declare logical resources, pass accesses, and terminal outputs; the compiler derives one execution plan; the executor resolves physical resources and records the plan through restricted pass capabilities.

## Responsibilities

| Directory   | Responsibility                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `types/`    | Shared logical resource, restricted capability, compiler result, and execution-plan types.                                                |
| `builder/`  | Logical handles, versioned resource declarations, pass setup, prepared-resource tokens, and RenderSystem contribution.                    |
| `compiler/` | Range normalization, hazard analysis, culling, lifetime and alias planning, history state, and Debug IR.                                  |
| `context/`  | Internal pass-local capability resolution, encoder proxies, descriptor lowering, and owned-resource retirement.                           |
| `executor/` | Canonical plan validation, surface-frame ownership, physical resource binding, transient pooling, encoding, submission, and presentation. |
| `index.ts`  | Stable public RenderGraph exports. Internal `context` and executor helper modules are intentionally excluded.                             |

## Lifecycle

```mermaid
sequenceDiagram
    participant System as RenderSystem
    participant Builder as RenderGraphBuilder
    participant Compiler as Compiler
    participant Executor as Executor
    participant Context as RestrictedPassContext
    participant Queue as RHIQueue

    System->>Builder: Declare resources and pass accesses
    Builder->>Compiler: Publish immutable graph snapshot
    Compiler->>Compiler: Derive hazards, culling, lifetimes, and aliases
    Compiler-->>Executor: Canonical execution plan
    Executor->>Executor: Validate plan and prepared resources
    Executor->>Executor: Acquire required surface frames
    Executor->>Context: Resolve declared pass-local capabilities
    Context->>Queue: Record through the executor-owned encoder
    Executor->>Queue: Submit one command buffer
    Executor->>Executor: Retain resources until submission terminal
    Executor->>Executor: Present successful surface outputs
```

## Ownership Boundaries

- Builder inputs are caller-owned. Published graph snapshots detach or freeze retained values according to their public contracts.
- Logical handles are scoped to one graph identity and resource version. Consumers must not reconstruct or mutate them.
- Imported resources remain externally owned. Transient resources are owned by the executor pool and may be reused only after all retaining submissions become terminal.
- A surface frame belongs to exactly one executor invocation. A successful submission ends in `present()`; a pre-submit failure ends in `release()`.
- Pass callbacks receive only `RestrictedPassContext`. They cannot acquire surfaces, submit queues, allocate arbitrary persistent resources, or access undeclared graph resources.
- Prepared pipelines and draw resources are created before surface acquisition and validated again at the submission boundary.

## Fail-Fast Invariants

1. Execution accepts only a canonical plan produced for the exact immutable graph snapshot.
2. Every pass access must reference a handle owned by the current graph and a declared compatible range and usage.
3. A pass must end an active raster or compute encoder before returning.
4. Restricted capabilities expire when their pass context closes.
5. An acquired surface frame reaches one terminal state exactly once.
6. Failed or device-lost transient resources are destroyed instead of returning to the reusable pool.
7. History read and write slots remain distinct; publication occurs only after successful submission completion.

## Public API Boundary

The package barrel exports authoring, compilation, execution, history, debug, prepared-resource, and RenderSystem contracts. Pass-builder state, restricted-context implementations, encoder proxies, executor cleanup, physical binding, and lowering helpers remain internal. New public exports require an explicit contract and a public API regression test.
