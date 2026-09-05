/**
 * @file Strongly-typed port definitions, data types, node signatures, and graph schemas for ShaderGraph.
 */

import type { ShaderDiagnostic } from '../../../types';

/**
 * Port resource categories.
 */
export type ShaderPortKind = 'value' | 'texture' | 'sampler';

/**
 * Closed set of strongly-typed shader data types supported by ShaderGraph.
 */
export type ShaderDataType =
  | 'bool'
  | 'f32'
  | 'i32'
  | 'u32'
  | 'vec2f'
  | 'vec3f'
  | 'vec4f'
  | 'texture_2d<f32>'
  | 'sampler'
  | 'sampler_comparison';

/**
 * Execution shader stage for nodes and ports.
 */
export type ShaderStage = 'vertex' | 'fragment' | 'compute';

/**
 * Stage mask indicating allowed execution stages.
 */
export type ShaderStageMask = ShaderStage | 'all';

/**
 * Port specification for a shader node.
 */
export interface ShaderPortDefinition {
  readonly id: string;
  readonly name: string;
  readonly type: ShaderDataType;
  readonly kind: ShaderPortKind;
}

/**
 * Signature overload for a shader node.
 */
export interface ShaderNodeSignature {
  readonly inputs: readonly ShaderPortDefinition[];
  readonly outputs: readonly ShaderPortDefinition[];
  readonly stage: ShaderStageMask;
}

/**
 * Declarative specification of a shader node type.
 */
export interface ShaderNodeDefinition {
  readonly kind: string;
  readonly description: string;
  readonly signatures: readonly ShaderNodeSignature[];
}

/**
 * Connection endpoint specifying source node and its output port.
 */
export interface ShaderNodeConnection {
  readonly nodeId: string;
  readonly portId?: string;
}

/**
 * Authoring representation of an individual node in the graph.
 * Pure composition domain model: does NOT extend DAGNode.
 */
export interface ShaderGraphNode {
  readonly id: string;
  readonly kind: string;
  readonly outputType?: ShaderDataType;
  readonly inputs?: Readonly<Record<string, string | ShaderNodeConnection>>;
  readonly value?: unknown;
  readonly stage?: ShaderStage;
  readonly location?: number;
  readonly group?: number;
  readonly binding?: number;
  readonly name?: string;
}

/**
 * Graph representation containing nodes and entry-point outputs.
 */
export interface ShaderGraph {
  readonly revision: number;
  readonly nodes: readonly ShaderGraphNode[];
  readonly outputs: Readonly<Record<string, string | ShaderNodeConnection>>;
}

/**
 * Intermediate typed representation of a lowered shader graph before emission.
 */
export interface TypedGraphIR {
  readonly vertexInputs: readonly {
    readonly location: number;
    readonly name: string;
    readonly type: ShaderDataType;
  }[];
  readonly fragmentOutputs: readonly {
    readonly location: number;
    readonly name: string;
    readonly type: ShaderDataType;
  }[];
  readonly uniforms: readonly {
    readonly group: number;
    readonly binding: number;
    readonly varName: string;
    readonly typeName: string;
    readonly fields: readonly { readonly name: string; readonly type: ShaderDataType }[];
  }[];
  readonly textures: readonly {
    readonly group: number;
    readonly binding: number;
    readonly name: string;
  }[];
  readonly samplers: readonly {
    readonly group: number;
    readonly binding: number;
    readonly name: string;
  }[];
  readonly vertexStatements: readonly string[];
  readonly fragmentStatements: readonly string[];
  readonly computeStatements: readonly string[];
  readonly vertexReturnExpr: string;
  readonly vertexReturnType: ShaderDataType;
  readonly fragmentReturnExpr: string;
  readonly fragmentReturnType: ShaderDataType;
}

/**
 * Worker compilation request.
 */
export interface ShaderGraphWorkerRequest {
  readonly revision: number;
  readonly priority: number;
  readonly graph: ShaderGraph;
  readonly signal: AbortSignal;
}

/**
 * Worker compilation result.
 */
export interface ShaderGraphWorkerResult<T> {
  readonly revision: number;
  readonly artifact: T;
}

/**
 * Worker port abstraction for off-thread graph compilation.
 */
export interface ShaderGraphWorkerPort<T> {
  compile(request: ShaderGraphWorkerRequest): Promise<ShaderGraphWorkerResult<T>>;
}

/**
 * Result returned by {@link ShaderGraphCompileService}.
 */
export type ShaderGraphServiceResult<T> =
  | Readonly<{ status: 'completed'; revision: number; artifact: T }>
  | Readonly<{ status: 'stale' | 'cancelled'; revision: number }>
  | Readonly<{ status: 'failed'; revision: number; error: unknown }>;

/**
 * Result returned by lower.
 */
export type ShaderGraphResult =
  | Readonly<{
      ok: true;
      revision: number;
      ir: TypedGraphIR;
      wgsl: string;
      metadataJson: string;
      reusedNodes: number;
      sourceHash: string;
    }>
  | Readonly<{
      ok: false;
      diagnostics: readonly ShaderDiagnostic[];
      cancelled?: boolean;
    }>;

export interface CachedNodeExpression {
  readonly outputType: ShaderDataType;
  readonly op: string;
  readonly statement?: string;
  readonly nodeId?: string;
  readonly literal?: string;
}
