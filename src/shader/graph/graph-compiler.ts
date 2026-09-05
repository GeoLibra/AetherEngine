/**
 * @file ShaderGraph compiler and async service implementation.
 * Performs topological ordering, three-color cycle detection, Merkle DAG content-addressed
 * incremental caching, and lowers DAG nodes directly into standard WGSL code without FluxSL dependencies.
 */

import { stableHash } from '../../core';
import type {
  ShaderDiagnostic,
  ShaderGraph,
  ShaderGraphNode,
  ShaderGraphServiceResult,
  ShaderGraphWorkerPort,
  SourceSpan
} from '../types';

const NO_SHADER_DIAGNOSTICS: readonly ShaderDiagnostic[] = Object.freeze([]);
const NO_RELATED_SPANS: readonly SourceSpan[] = Object.freeze([]);

/**
 * Result returned by {@link ShaderGraphCompiler.lower}.
 */
export type ShaderGraphResult =
  | Readonly<{
      ok: true;
      revision: number;
      wgsl: string;
      reusedNodes: number;
      sourceHash: string;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly ShaderDiagnostic[];
      cancelled?: boolean;
    }>;

function formatWgslLiteral(value: unknown, outputType: string): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (outputType === 'f32') {
      return Number.isInteger(value) ? `${value}.0` : `${value}`;
    }
    if (outputType === 'i32') {
      return `${value}i`;
    }
    if (outputType === 'u32') {
      return `${value}u`;
    }
    return `${value}`;
  }
  return String(value ?? 0);
}

function formatReturnExpression(outputId: string, outputType: string, stage: string): string {
  if (stage === 'fragment') {
    if (outputType === 'vec4f' || outputType === 'vec4<f32>') {
      return outputId;
    }
    if (outputType === 'vec3f' || outputType === 'vec3<f32>') {
      return `vec4f(${outputId}, 1.0)`;
    }
    if (outputType === 'vec2f' || outputType === 'vec2<f32>') {
      return `vec4f(${outputId}, 0.0, 1.0)`;
    }
    if (outputType === 'f32') {
      return `vec4f(${outputId}, ${outputId}, ${outputId}, 1.0)`;
    }
    return `vec4f(${outputId})`;
  }
  if (stage === 'vertex') {
    if (outputType === 'vec4f' || outputType === 'vec4<f32>') {
      return outputId;
    }
    if (outputType === 'vec3f' || outputType === 'vec3<f32>') {
      return `vec4f(${outputId}, 1.0)`;
    }
    return `vec4f(${outputId})`;
  }
  return outputId;
}

/**
 * Compiles a visual ShaderGraph DAG into standard WGSL shader source code.
 */
export class ShaderGraphCompiler {
  private readonly nodeCache = new Map<string, string>();

  /**
   * Validates graph topology and lowers nodes into standard WGSL.
   *
   * @param graph Authoring graph representation.
   * @param signal Optional cancellation signal.
   * @returns Successful compilation containing standard WGSL, or diagnostic errors.
   */
  async lower(graph: ShaderGraph, signal?: AbortSignal): Promise<ShaderGraphResult> {
    if (signal?.aborted) {
      return Object.freeze({ ok: false, cancelled: true, diagnostics: NO_SHADER_DIAGNOSTICS });
    }

    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const order: ShaderGraphNode[] = [];
    const active = new Set<string>();
    const done = new Set<string>();

    const visit = (id: string): ShaderDiagnostic | undefined => {
      if (active.has(id)) {
        return graphDiagnostic('GRAPH_CYCLE', `ShaderGraph contains a cycle through "${id}".`);
      }
      if (done.has(id)) {
        return undefined;
      }
      const node = nodes.get(id);
      if (!node) {
        return graphDiagnostic(
          'GRAPH_MISSING_NODE',
          `ShaderGraph references missing node "${id}".`
        );
      }
      active.add(id);
      for (const dependency of Object.values(node.inputs ?? {})) {
        const error = visit(dependency);
        if (error) {
          return error;
        }
      }
      active.delete(id);
      done.add(id);
      order.push(node);
      return undefined;
    };

    for (const output of Object.values(graph.outputs)) {
      const error = visit(output);
      if (error) {
        return Object.freeze({ ok: false, diagnostics: Object.freeze([error]) });
      }
    }

    let reusedNodes = 0;
    const statements = new Map<string, string>();
    const nodeHashes = new Map<string, string>();

    for (const node of order) {
      if (signal?.aborted) {
        return Object.freeze({ ok: false, cancelled: true, diagnostics: NO_SHADER_DIAGNOSTICS });
      }

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
        statements.set(node.id, cached);
        reusedNodes++;
        continue;
      }

      let expression = '';
      if (node.kind === 'constant') {
        expression = formatWgslLiteral(node.value, node.outputType);
      } else if (node.kind === 'add') {
        const left = node.inputs?.left ?? '';
        const right = node.inputs?.right ?? '';
        expression = `${left} + ${right}`;
      } else if (node.kind === 'subtract' || node.kind === 'sub') {
        const left = node.inputs?.left ?? '';
        const right = node.inputs?.right ?? '';
        expression = `${left} - ${right}`;
      } else if (node.kind === 'multiply' || node.kind === 'mul') {
        const left = node.inputs?.left ?? '';
        const right = node.inputs?.right ?? '';
        expression = `${left} * ${right}`;
      } else if (node.kind === 'divide' || node.kind === 'div') {
        const left = node.inputs?.left ?? '';
        const right = node.inputs?.right ?? '';
        expression = `${left} / ${right}`;
      } else {
        const args = Object.values(node.inputs ?? {}).join(', ');
        expression = `${node.kind}(${args})`;
      }

      const statement = `let ${node.id}: ${node.outputType} = ${expression};`;
      this.nodeCache.set(hash, statement);
      statements.set(node.id, statement);
    }

    const bodyLines = order.map((node) => `  ${statements.get(node.id)!}`).join('\n');

    const entryPointBlocks: string[] = [];
    for (const [stage, outputId] of Object.entries(graph.outputs)) {
      const outputNode = nodes.get(outputId);
      const outputType = outputNode?.outputType ?? 'vec4f';
      if (stage === 'fragment') {
        const retExpr = formatReturnExpression(outputId, outputType, 'fragment');
        entryPointBlocks.push(
          `@fragment\nfn fragmentMain() -> @location(0) vec4f {\n${bodyLines}\n  return ${retExpr};\n}`
        );
      } else if (stage === 'vertex') {
        const retExpr = formatReturnExpression(outputId, outputType, 'vertex');
        entryPointBlocks.push(
          `@vertex\nfn vertexMain() -> @builtin(position) vec4f {\n${bodyLines}\n  return ${retExpr};\n}`
        );
      } else if (stage === 'compute') {
        entryPointBlocks.push(`@compute @workgroup_size(64)\nfn computeMain() {\n${bodyLines}\n}`);
      }
    }

    const wgsl = entryPointBlocks.join('\n\n');
    const sourceHash = stableHash(graph);

    return Object.freeze({
      ok: true,
      revision: graph.revision,
      wgsl,
      reusedNodes,
      sourceHash
    });
  }

  /**
   * Evaluates if a completed compile result matches the currently desired revision.
   */
  acceptResult(result: Readonly<{ revision: number }>, currentRevision: number): boolean {
    return result.revision === currentRevision;
  }
}

/**
 * Manages asynchronous shader graph compilation jobs, cancellation, and last-known-good caching.
 */
export class ShaderGraphCompileService<T = unknown> {
  private readonly active = new Map<string, AbortController>();
  private readonly latest = new Map<string, number>();
  private readonly good = new Map<string, T>();

  constructor(private readonly worker: ShaderGraphWorkerPort<T>) {}

  /**
   * Enqueues or updates a compile request. Superseded requests with matching key are aborted.
   */
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

      if (this.latest.get(request.key) !== request.revision) {
        return Object.freeze({ status: 'stale', revision: request.revision });
      }
      if (controller.signal.aborted) {
        return Object.freeze({ status: 'cancelled', revision: request.revision });
      }

      this.good.set(request.key, result.artifact);
      this.active.delete(request.key);
      return Object.freeze({
        status: 'completed',
        revision: request.revision,
        artifact: result.artifact
      });
    } catch (error) {
      if (controller.signal.aborted) {
        return Object.freeze({ status: 'cancelled', revision: request.revision });
      }
      return Object.freeze({ status: 'failed', revision: request.revision, error });
    }
  }

  /**
   * Returns the last-known-good compiled artifact for a graph key.
   */
  lastKnownGood(key: string): T | undefined {
    return this.good.get(key);
  }

  /**
   * Explicitly cancels active compilation for a given key.
   */
  cancel(key: string, reason = 'cancelled'): void {
    this.active.get(key)?.abort(reason);
    this.active.delete(key);
  }
}

/**
 * Classifies an incremental change in a shader graph to determine minimal recompilation scope.
 */
export function classifyShaderGraphChange(
  change: Readonly<{
    kind:
      'parameter-value' | 'texture-binding' | 'sampler-binding' | 'topology' | 'type' | 'variant';
  }>
): 'parameter-update' | 'binding-update' | 'recompile' | 'variant-compile' {
  if (change.kind === 'parameter-value') {
    return 'parameter-update';
  }
  if (change.kind === 'texture-binding' || change.kind === 'sampler-binding') {
    return 'binding-update';
  }
  if (change.kind === 'variant') {
    return 'variant-compile';
  }
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
    related: NO_RELATED_SPANS
  });
}
