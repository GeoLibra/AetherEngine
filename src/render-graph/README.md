# RenderGraph Subsystem

RenderGraph separates declarative render work from physical RHI execution. Systems declare logical resources, pass accesses, and terminal outputs; the compiler derives one execution plan; the executor resolves physical resources and records the plan through restricted pass capabilities.

## Responsibilities

| Directory   | Responsibility                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `types/`    | Shared logical resource, restricted capability, compiler result, and execution-plan types.                                                |
| `builder/`  | Logical handles, versioned resource declarations, pass setup, and prepared-resource tokens.                                               |
| `ranges/`   | Texture and buffer range types, normalization, subresource interval intersection, subtraction, and overlap algorithms.                    |
| `history/`  | Multi-frame resource history registry, double/triple-buffering slot acquisition, view invalidation, and retirement lifecycles.            |
| `debug/`    | Read-only projection, serialization, and deterministic checksum generation of compiled and executed render graph plans.                   |
| `compiler/` | DAG validation, hazard analysis, culling, topology, lifetime/alias/transition planning, and raster pass fusion partitioning.              |
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
    participant Context as TypedPassContexts
    participant Queue as RHIQueue

    System->>Builder: Declare resources and pass accesses
    Builder->>Compiler: Publish immutable graph snapshot
    Compiler->>Compiler: Derive hazards, culling, lifetimes, and aliases
    Compiler-->>Executor: Canonical execution plan
    Executor->>Executor: Validate plan and prepared resources
    Executor->>Executor: Acquire required surface frames
    Executor->>Context: Create isolated typed pass context (Raster/Compute/Copy)
    Context->>Queue: Record through typed context commands
    Executor->>Queue: Submit one command buffer
    Executor->>Executor: Retain resources until submission terminal
    Executor->>Executor: Present successful surface outputs
```

## Ownership Boundaries

- Builder inputs are caller-owned. Published graph snapshots detach or freeze retained values according to their public contracts.
- Logical handles are scoped to one graph identity and resource version. Consumers must not reconstruct or mutate them.
- Imported resources remain externally owned. Transient resources are owned by the executor pool and may be reused only after all retaining submissions become terminal.
- A surface frame belongs to exactly one executor invocation. A successful submission ends in `present()`; a pre-submit failure ends in `release()`.
- Pass callbacks receive only their matching typed pass context (`RasterPassContext`, `ComputePassContext`, or `CopyPassContext`). They cannot acquire surfaces, submit queues, allocate arbitrary persistent resources, or access undeclared graph resources.
- Prepared pipelines and draw resources are created before surface acquisition and validated again at the submission boundary.

## Fail-Fast Invariants

1. Execution accepts only a canonical plan produced for the exact immutable graph snapshot.
2. Every pass access must reference a handle owned by the current graph and a declared compatible range and usage.
3. Pass commands can only be invoked within their active synchronous callback scope; physical pass and encoder lifecycles are owned and closed by the executor and fusion partitions.
4. Restricted capabilities expire when their pass context closes.
5. An acquired surface frame reaches one terminal state exactly once.
6. Failed or device-lost transient resources are destroyed instead of returning to the reusable pool.
7. History read and write slots remain distinct; publication occurs only after successful submission completion.
8. Raster pass fusion preserves logical pass context isolation, attachment clearing, draw validation, and error boundaries while sharing one physical render pass encoder.

## Public API Boundary

The package barrel exports authoring, compilation, execution, history, debug, and prepared-resource contracts. Pass-builder state, restricted-context implementations, encoder proxies, executor cleanup, physical binding, and lowering helpers remain internal. New public exports require an explicit contract and a public API regression test.

```
RenderGraphSnapshot (Builder 的输入)
   │
   ├── 1. 冲突分析 (hazards.ts)：RAW(读后写)/WAR(写后读)/WAW 冲突推导，建立物理依赖边
   │
   ├── 2. 拓扑规划与剔除 (schedule/)：死 Pass 剔除 (Culling) + Kahn 拓扑排序 + 成环死锁检测
   │
   ├── 3. 硬件级通道融合 (fusion/)：将多个逻辑 Raster Pass 合并为一个物理 Pass (移动端 TBDR 架构神技)
   │
   └── 4. 显存复用与状态规划 (resources/)：生命周期分析 [firstUse, lastUse] + 显存别名 (Aliasing) + 屏障规划 (Transition)
   │
   ▼
RenderGraphExecutionPlan (最终输出给 Executor 的执行计划)
```

```
上层提交的无序/半无序 Pass 声明
           │
           ▼
[ Hazard 分析模块（当前代码）]
   通过 Subresource 几何相交判定，找出所有的 RAW / WAR / WAW
   输出：有向无环图的“依赖边”（Edges）
           │
           ▼
[ 后续编译与调度优化阶段 ]
   ├─ 1. 拓扑排序 (Topological Sort): 确定 GPU 队列的合法执行顺序
   ├─ 2. 死代码消除 (Culling): 如果某个 Write 没人读且不是终端，直接剔除该 Pass
   ├─ 3. 合并决策 (Pass Merging): 判断符合条件的相交 Pass 能否就地融合（Subpass）
   └─ 4. 插入同步指令 (Barriers): 在无法合并的依赖边之间，精准插入最小粒度的 GPU 屏障
```
