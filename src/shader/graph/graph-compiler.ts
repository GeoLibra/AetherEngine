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

const WGSL_IDENTIFIER_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const WGSL_RESERVED_KEYWORDS = new Set([
  'alias',
  'break',
  'case',
  'const',
  'const_assert',
  'continue',
  'continuing',
  'default',
  'diagnostic',
  'discard',
  'else',
  'enable',
  'false',
  'fn',
  'for',
  'if',
  'let',
  'loop',
  'override',
  'requires',
  'return',
  'struct',
  'switch',
  'true',
  'var',
  'while',
  'type',
  'null',
  'void',
  'self',
  'super'
]);

/**
 * Checks whether an identifier string is a valid WGSL identifier and not a reserved keyword.
 */
export function isValidWgslIdentifier(id: string): boolean {
  return WGSL_IDENTIFIER_PATTERN.test(id) && !WGSL_RESERVED_KEYWORDS.has(id);
}

const KNOWN_NODE_KINDS = new Set([
  'constant',
  'add',
  'subtract',
  'sub',
  'multiply',
  'mul',
  'divide',
  'div'
]);

interface CachedNodeExpression {
  readonly outputType: string;
  readonly op: 'constant' | 'add' | 'subtract' | 'multiply' | 'divide';
  readonly literal?: string;
}

type LiteralResult =
  Readonly<{ ok: true; literal: string }> | Readonly<{ ok: false; message: string }>;

function formatWgslLiteral(value: unknown, outputType: string): LiteralResult {
  if (outputType === 'bool') {
    if (typeof value === 'boolean') {
      return { ok: true, literal: value ? 'true' : 'false' };
    }
    return { ok: false, message: `Expected boolean for type "bool", received ${typeof value}.` };
  }
  if (outputType === 'f32') {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return { ok: true, literal: Number.isInteger(value) ? `${value}.0` : `${value}` };
    }
    return {
      ok: false,
      message: `Expected finite number for type "f32", received ${String(value)}.`
    };
  }
  if (outputType === 'i32') {
    if (
      typeof value === 'number' &&
      Number.isInteger(value) &&
      value >= -2147483648 &&
      value <= 2147483647
    ) {
      return { ok: true, literal: `${value}i` };
    }
    return {
      ok: false,
      message: `Expected 32-bit signed integer for type "i32", received ${String(value)}.`
    };
  }
  if (outputType === 'u32') {
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 4294967295) {
      return { ok: true, literal: `${value}u` };
    }
    return {
      ok: false,
      message: `Expected 32-bit unsigned integer for type "u32", received ${String(value)}.`
    };
  }
  if (outputType === 'vec2f' || outputType === 'vec2<f32>') {
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return {
        ok: true,
        literal: `vec2f(${value.map((v) => (Number.isInteger(v) ? `${v}.0` : `${v}`)).join(', ')})`
      };
    }
    return { ok: false, message: `Expected 2-element finite number array for "${outputType}".` };
  }
  if (outputType === 'vec3f' || outputType === 'vec3<f32>') {
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return {
        ok: true,
        literal: `vec3f(${value.map((v) => (Number.isInteger(v) ? `${v}.0` : `${v}`)).join(', ')})`
      };
    }
    return { ok: false, message: `Expected 3-element finite number array for "${outputType}".` };
  }
  if (outputType === 'vec4f' || outputType === 'vec4<f32>') {
    if (
      Array.isArray(value) &&
      value.length === 4 &&
      value.every((v) => typeof v === 'number' && Number.isFinite(v))
    ) {
      return {
        ok: true,
        literal: `vec4f(${value.map((v) => (Number.isInteger(v) ? `${v}.0` : `${v}`)).join(', ')})`
      };
    }
    return { ok: false, message: `Expected 4-element finite number array for "${outputType}".` };
  }
  return { ok: false, message: `Unsupported literal type "${outputType}".` };
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
 * Bounded LRU cache for lowered node expressions.
 */
export class BoundedNodeCache {
  private readonly maxCapacity: number;
  private readonly cache = new Map<string, CachedNodeExpression>();

  constructor(maxCapacity = 1024) {
    this.maxCapacity = Math.max(1, maxCapacity);
  }

  get(key: string): CachedNodeExpression | undefined {
    const value = this.cache.get(key);
    if (value !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, value);
    }
    return value;
  }

  set(key: string, value: CachedNodeExpression): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxCapacity) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * Compiles a visual ShaderGraph DAG into standard WGSL shader source code.
 */
export class ShaderGraphCompiler {
  private readonly nodeCache: BoundedNodeCache;

  constructor(options?: { cacheCapacity?: number }) {
    this.nodeCache = new BoundedNodeCache(options?.cacheCapacity ?? 1024);
  }

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

    const seenIds = new Set<string>();
    for (const node of graph.nodes) {
      if (seenIds.has(node.id)) {
        return Object.freeze({
          ok: false,
          diagnostics: Object.freeze([
            graphDiagnostic(
              'GRAPH_DUPLICATE_NODE_ID',
              `ShaderGraph contains duplicate node ID "${node.id}".`
            )
          ])
        });
      }
      if (!isValidWgslIdentifier(node.id)) {
        return Object.freeze({
          ok: false,
          diagnostics: Object.freeze([
            graphDiagnostic(
              'GRAPH_INVALID_IDENTIFIER',
              `Node ID "${node.id}" is not a valid WGSL identifier.`
            )
          ])
        });
      }
      if (!KNOWN_NODE_KINDS.has(node.kind)) {
        return Object.freeze({
          ok: false,
          diagnostics: Object.freeze([
            graphDiagnostic(
              'GRAPH_UNKNOWN_NODE_TYPE',
              `Unknown node type "${node.kind}" on node "${node.id}".`
            )
          ])
        });
      }
      if (node.kind === 'constant') {
        if (node.inputs && Object.keys(node.inputs).length > 0) {
          return Object.freeze({
            ok: false,
            diagnostics: Object.freeze([
              graphDiagnostic(
                'GRAPH_INVALID_PORT',
                `Constant node "${node.id}" must not have inputs.`
              )
            ])
          });
        }
      } else {
        const inputKeys = Object.keys(node.inputs ?? {});
        if (!node.inputs?.left || !node.inputs?.right || inputKeys.length !== 2) {
          return Object.freeze({
            ok: false,
            diagnostics: Object.freeze([
              graphDiagnostic(
                'GRAPH_INVALID_PORT',
                `Node "${node.id}" of kind "${node.kind}" requires exactly "left" and "right" inputs.`
              )
            ])
          });
        }
      }
      seenIds.add(node.id);
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

      let op: CachedNodeExpression['op'] = 'constant';
      let literal: string | undefined;

      if (node.kind === 'constant') {
        const litRes = formatWgslLiteral(node.value, node.outputType);
        if (!litRes.ok) {
          return Object.freeze({
            ok: false,
            diagnostics: Object.freeze([
              graphDiagnostic(
                'GRAPH_INVALID_LITERAL',
                `Node "${node.id}" has invalid literal: ${litRes.message}`
              )
            ])
          });
        }
        literal = litRes.literal;
      } else if (node.kind === 'add') {
        op = 'add';
      } else if (node.kind === 'subtract' || node.kind === 'sub') {
        op = 'subtract';
      } else if (node.kind === 'multiply' || node.kind === 'mul') {
        op = 'multiply';
      } else if (node.kind === 'divide' || node.kind === 'div') {
        op = 'divide';
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
        reusedNodes++;
        const expr = formatBinaryExpression(cached.op, node.inputs, cached.literal);
        statements.set(node.id, `let ${node.id}: ${node.outputType} = ${expr};`);
        continue;
      }

      const expr = formatBinaryExpression(op, node.inputs, literal);
      const cachedEntry: CachedNodeExpression = Object.freeze({
        outputType: node.outputType,
        op,
        ...(literal !== undefined ? { literal } : {})
      });
      this.nodeCache.set(hash, cachedEntry);
      statements.set(node.id, `let ${node.id}: ${node.outputType} = ${expr};`);
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
    const sourceHash = stableHash({
      nodes: graph.nodes,
      outputs: graph.outputs
    });

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

function formatBinaryExpression(
  op: CachedNodeExpression['op'],
  inputs: Readonly<Record<string, string>> | undefined,
  literal: string | undefined
): string {
  if (op === 'constant') {
    return literal ?? '0.0';
  }
  const left = inputs?.left ?? '';
  const right = inputs?.right ?? '';
  if (op === 'add') {
    return `${left} + ${right}`;
  }
  if (op === 'subtract') {
    return `${left} - ${right}`;
  }
  if (op === 'multiply') {
    return `${left} * ${right}`;
  }
  return `${left} / ${right}`;
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
