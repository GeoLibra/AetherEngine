import { stableHash } from '../../core';
import type {
  ShaderDiagnostic,
  ShaderExpressionIR,
  ShaderFunctionId,
  ShaderGraph,
  ShaderGraphNode,
  ShaderGraphServiceResult,
  ShaderGraphWorkerPort,
  ShaderModuleIR,
  ShaderSymbolId,
  ShaderTypeId,
  SourceSpan
} from '../types';

const NO_SHADER_DIAGNOSTICS: readonly ShaderDiagnostic[] = Object.freeze([]);
const NO_RELATED_SPANS: readonly SourceSpan[] = Object.freeze([]);
const NO_SHADER_IR_ITEMS: readonly never[] = Object.freeze([]);

type GraphResult =
  | Readonly<{ ok: true; revision: number; ir: ShaderModuleIR; reusedNodes: number }>
  | Readonly<{ ok: false; diagnostics: readonly ShaderDiagnostic[]; cancelled?: boolean }>;

export class ShaderGraphCompiler {
  private readonly nodeCache = new Map<string, ShaderExpressionIR>();

  /**
   * Lowers a high-level `ShaderGraph` into a typed `ShaderModuleIR`.
   *
   * Executes in five deterministic pipeline steps:
   * 1. Cancellation check (pre-flight)
   * 2. Dependency resolution, cycle detection, and topological sorting (DFS)
   * 3. Input-output type validation and sub-expression hashing / CSE cache lookup
   * 4. IR Expression emission and node cache population
   * 5. Entry point generation and final ShaderModuleIR packaging
   *
   * @param graph The source ShaderGraph definition and outputs.
   * @param signal Optional AbortSignal to cancel long-running graph compilation.
   * @returns Result containing the lowered ShaderModuleIR or compilation diagnostics.
   */
  async lower(graph: ShaderGraph, signal?: AbortSignal): Promise<GraphResult> {
    // -------------------------------------------------------------------------
    // Step 1: Pre-flight cancellation check
    // -------------------------------------------------------------------------
    if (signal?.aborted) {
      return Object.freeze({ ok: false, cancelled: true, diagnostics: NO_SHADER_DIAGNOSTICS });
    }

    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const order: ShaderGraphNode[] = [];
    const active = new Set<string>();
    const done = new Set<string>();

    // -------------------------------------------------------------------------
    // Step 2: DFS traversal for cycle detection, missing node check, and topological sort
    // -------------------------------------------------------------------------
    const visit = (id: string): ShaderDiagnostic | undefined => {
      // 2.1 Cycle detection (node is in current active traversal stack)
      if (active.has(id)) {
        return graphDiagnostic('GRAPH_CYCLE', `ShaderGraph contains a cycle through "${id}".`);
      }
      // 2.2 Already resolved and sorted
      if (done.has(id)) return undefined;

      const node = nodes.get(id);
      // 2.3 Dangling reference check
      if (!node) {
        return graphDiagnostic(
          'GRAPH_MISSING_NODE',
          `ShaderGraph references missing node "${id}".`
        );
      }

      active.add(id);
      // 2.4 Recursively visit upstream dependency inputs
      for (const dependency of Object.values(node.inputs ?? {})) {
        const error = visit(dependency);
        if (error) return error;
      }
      active.delete(id);
      done.add(id);

      // 2.5 Post-order push guarantees dependencies come before dependents
      order.push(node);
      return undefined;
    };

    // Traverse upstream graph starting from all declared stage outputs
    for (const output of Object.values(graph.outputs)) {
      const error = visit(output);
      if (error) return Object.freeze({ ok: false, diagnostics: Object.freeze([error]) });
    }

    let reusedNodes = 0;
    const expressions = new Map<string, ShaderExpressionIR>();
    const nodeHashes = new Map<string, string>();

    // -------------------------------------------------------------------------
    // Step 3 & 4: Type validation, Common Subexpression Elimination (CSE) cache, and IR emission
    // -------------------------------------------------------------------------
    for (const node of order) {
      // Check cancellation during batch lowering
      if (signal?.aborted) {
        return Object.freeze({ ok: false, cancelled: true, diagnostics: NO_SHADER_DIAGNOSTICS });
      }

      // Step 3.1: Validate input/output port type compatibility
      for (const dependency of Object.values(node.inputs ?? {})) {
        const source = nodes.get(dependency)!;
        if (source.outputType !== node.outputType) {
          return Object.freeze({
            ok: false,
            diagnostics: Object.freeze([
              graphDiagnostic(
                'GRAPH_TYPE_MISMATCH',
                `Node "${node.id}" expects ${node.outputType} but "${dependency}" produces ${source.outputType}.`
              )
            ])
          });
        }
      }

      // Step 3.2: Compute deterministic content hash for node & its dependencies (for CSE)
      const hash = stableHash({
        kind: node.kind,
        outputType: node.outputType,
        dependencies: Object.entries(node.inputs ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, id]) => [name, nodeHashes.get(id)]),
        value: node.value
      });
      nodeHashes.set(node.id, hash);

      // Step 3.3: Cache hit - reuse existing expression IR (CSE optimization)
      const cached = this.nodeCache.get(hash);
      if (cached !== undefined) {
        expressions.set(node.id, cached);
        reusedNodes++;
        continue;
      }

      // Step 4: Emit typed ShaderExpressionIR
      const type = node.outputType as ShaderTypeId;
      const expression: ShaderExpressionIR =
        node.kind === 'constant'
          ? Object.freeze({
              kind: 'literal',
              value: typeof node.value === 'boolean' ? node.value : Number(node.value),
              type,
              span: graphSpan()
            })
          : node.kind === 'add'
            ? Object.freeze({
                kind: 'binary',
                operator: '+',
                left: expressions.get(node.inputs?.left ?? '')!,
                right: expressions.get(node.inputs?.right ?? '')!,
                type,
                span: graphSpan()
              })
            : Object.freeze({
                kind: 'intrinsic',
                intrinsic: node.kind,
                arguments: Object.freeze(
                  Object.values(node.inputs ?? {}).map((id) => expressions.get(id)!)
                ),
                type,
                span: graphSpan()
              });

      this.nodeCache.set(hash, expression);
      expressions.set(node.id, expression);
    }

    // -------------------------------------------------------------------------
    // Step 5: Construct stage entry points and package ShaderModuleIR
    // -------------------------------------------------------------------------
    const span = graphSpan();
    const ir: ShaderModuleIR = Object.freeze({
      version: 1,
      types: NO_SHADER_IR_ITEMS,
      globals: NO_SHADER_IR_ITEMS,
      functions: NO_SHADER_IR_ITEMS,
      entryPoints: Object.freeze(
        Object.entries(graph.outputs).map(([stage, id], index) =>
          Object.freeze({
            id: (index + 1) as ShaderFunctionId,
            name: `${stage}Main`,
            stage: stage as 'vertex' | 'fragment' | 'compute',
            parameters: NO_SHADER_IR_ITEMS,
            body: Object.freeze([
              Object.freeze({
                kind: 'declare' as const,
                id: (index + 1) as ShaderSymbolId,
                mutable: false,
                name: 'output',
                type: expressions.get(id)!.type,
                value: expressions.get(id)!,
                span
              })
            ]),
            span
          })
        )
      ),
      variants: NO_SHADER_IR_ITEMS,
      sourceMap: Object.freeze({ spans: Object.freeze([span]) }),
      sourceClosureHash: stableHash(graph)
    });

    return Object.freeze({ ok: true, revision: graph.revision, ir, reusedNodes });
  }

  /**
   * Validates whether a compilation result matches the current graph revision.
   *
   * Used by callers to discard stale asynchronous compilation results when the
   * graph has been edited again during compilation.
   *
   * @param result The compilation result containing the source revision.
   * @param currentRevision The active/latest revision of the ShaderGraph.
   * @returns `true` if the result matches the active revision; otherwise `false`.
   */
  acceptResult(result: Readonly<{ revision: number }>, currentRevision: number): boolean {
    return result.revision === currentRevision;
  }
}

export class ShaderGraphCompileService<T = unknown> {
  private readonly active = new Map<string, AbortController>();
  private readonly latest = new Map<string, number>();
  private readonly good = new Map<string, T>();
  constructor(private readonly worker: ShaderGraphWorkerPort<T>) {}
  async compile(
    request: Readonly<{ key: string; revision: number; priority: number; graph: ShaderGraph }>
  ): Promise<ShaderGraphServiceResult<T>> {
    this.active.get(request.key)?.abort('superseded');
    const controller = new AbortController();
    this.active.set(request.key, controller);
    this.latest.set(request.key, request.revision);
    try {
      const result = await this.worker.compile(
        Object.freeze({
          revision: request.revision,
          priority: request.priority,
          graph: request.graph,
          signal: controller.signal
        })
      );
      if (this.latest.get(request.key) !== request.revision)
        return Object.freeze({ status: 'stale', revision: request.revision });
      if (controller.signal.aborted)
        return Object.freeze({ status: 'cancelled', revision: request.revision });
      this.good.set(request.key, result.artifact);
      this.active.delete(request.key);
      return Object.freeze({
        status: 'completed',
        revision: request.revision,
        artifact: result.artifact
      });
    } catch (error) {
      if (controller.signal.aborted)
        return Object.freeze({ status: 'cancelled', revision: request.revision });
      return Object.freeze({ status: 'failed', revision: request.revision, error });
    }
  }
  lastKnownGood(key: string): T | undefined {
    return this.good.get(key);
  }
  cancel(key: string, reason = 'cancelled'): void {
    this.active.get(key)?.abort(reason);
    this.active.delete(key);
  }
}

export function classifyShaderGraphChange(
  change: Readonly<{
    kind:
      'parameter-value' | 'texture-binding' | 'sampler-binding' | 'topology' | 'type' | 'variant';
  }>
): 'parameter-update' | 'binding-update' | 'recompile' | 'variant-compile' {
  switch (change.kind) {
    case 'parameter-value':
      return 'parameter-update';
    case 'texture-binding':
    case 'sampler-binding':
      return 'binding-update';
    case 'variant':
      return 'variant-compile';
    case 'topology':
    case 'type':
      return 'recompile';
  }
}

function graphSpan(): SourceSpan {
  return Object.freeze({ uri: 'shadergraph://generated', line: 1, column: 1, length: 1 });
}

function graphDiagnostic(code: string, message: string): ShaderDiagnostic {
  return Object.freeze({
    severity: 'error',
    code,
    message,
    stage: 'typecheck',
    primary: graphSpan(),
    related: NO_RELATED_SPANS
  });
}
