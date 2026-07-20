import { stableHash } from './hash';
import type {
  ShaderDiagnostic,
  ShaderExpressionIR,
  ShaderFunctionId,
  ShaderModuleIR,
  ShaderSymbolId,
  ShaderTypeId,
  SourceSpan
} from './types';

export interface ShaderGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly outputType: string;
  readonly inputs?: Readonly<Record<string, string>>;
  readonly value?: unknown;
}
export interface ShaderGraph {
  readonly revision: number;
  readonly nodes: readonly ShaderGraphNode[];
  readonly outputs: Readonly<Record<string, string>>;
}
type GraphResult =
  | Readonly<{ ok: true; revision: number; ir: ShaderModuleIR; reusedNodes: number }>
  | Readonly<{ ok: false; diagnostics: readonly ShaderDiagnostic[]; cancelled?: boolean }>;

export class ShaderGraphCompiler {
  private readonly nodeCache = new Map<string, ShaderExpressionIR>();
  async lower(graph: ShaderGraph, signal?: AbortSignal): Promise<GraphResult> {
    if (signal?.aborted)
      return Object.freeze({ ok: false, cancelled: true, diagnostics: Object.freeze([]) });
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const order: ShaderGraphNode[] = [];
    const active = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string): ShaderDiagnostic | undefined => {
      if (active.has(id))
        return graphDiagnostic('GRAPH_CYCLE', `ShaderGraph contains a cycle through "${id}".`);
      if (done.has(id)) return undefined;
      const node = nodes.get(id);
      if (!node)
        return graphDiagnostic(
          'GRAPH_MISSING_NODE',
          `ShaderGraph references missing node "${id}".`
        );
      active.add(id);
      for (const dependency of Object.values(node.inputs ?? {})) {
        const error = visit(dependency);
        if (error) return error;
      }
      active.delete(id);
      done.add(id);
      order.push(node);
      return undefined;
    };
    for (const output of Object.values(graph.outputs)) {
      const error = visit(output);
      if (error) return Object.freeze({ ok: false, diagnostics: Object.freeze([error]) });
    }
    let reusedNodes = 0;
    const expressions = new Map<string, ShaderExpressionIR>();
    const nodeHashes = new Map<string, string>();
    for (const node of order) {
      if (signal?.aborted)
        return Object.freeze({ ok: false, cancelled: true, diagnostics: Object.freeze([]) });
      for (const dependency of Object.values(node.inputs ?? {})) {
        const source = nodes.get(dependency)!;
        if (source.outputType !== node.outputType)
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
      const hash = stableHash({
        kind: node.kind,
        outputType: node.outputType,
        dependencies: Object.entries(node.inputs ?? {})
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, id]) => [name, nodeHashes.get(id)]),
        value: node.value
      });
      nodeHashes.set(node.id, hash);
      const cached = this.nodeCache.get(hash);
      if (cached !== undefined) {
        expressions.set(node.id, cached);
        reusedNodes++;
        continue;
      }
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
    const span = graphSpan();
    const ir: ShaderModuleIR = Object.freeze({
      version: 1,
      types: Object.freeze([]),
      globals: Object.freeze([]),
      functions: Object.freeze([]),
      entryPoints: Object.freeze(
        Object.entries(graph.outputs).map(([stage, id], index) =>
          Object.freeze({
            id: (index + 1) as ShaderFunctionId,
            name: `${stage}Main`,
            stage: stage as 'vertex' | 'fragment' | 'compute',
            parameters: Object.freeze([]),
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
      variants: Object.freeze([]),
      sourceMap: Object.freeze({ spans: Object.freeze([span]) }),
      sourceClosureHash: stableHash(graph)
    });
    return Object.freeze({ ok: true, revision: graph.revision, ir, reusedNodes });
  }
  acceptResult(result: Readonly<{ revision: number }>, currentRevision: number): boolean {
    return result.revision === currentRevision;
  }
}

export interface ShaderGraphWorkerRequest {
  readonly revision: number;
  readonly priority: number;
  readonly graph: ShaderGraph;
  readonly signal: AbortSignal;
}
export interface ShaderGraphWorkerResult<T> {
  readonly revision: number;
  readonly artifact: T;
}
export interface ShaderGraphWorkerPort<T> {
  compile(request: ShaderGraphWorkerRequest): Promise<ShaderGraphWorkerResult<T>>;
}
export type ShaderGraphServiceResult<T> =
  | Readonly<{ status: 'completed'; revision: number; artifact: T }>
  | Readonly<{ status: 'stale' | 'cancelled'; revision: number }>
  | Readonly<{ status: 'failed'; revision: number; error: unknown }>;

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
  if (change.kind === 'parameter-value') return 'parameter-update';
  if (change.kind === 'texture-binding' || change.kind === 'sampler-binding')
    return 'binding-update';
  if (change.kind === 'variant') return 'variant-compile';
  return 'recompile';
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
    related: Object.freeze([])
  });
}
