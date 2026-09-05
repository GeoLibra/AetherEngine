/**
 * @file Unified lowering pipeline for ShaderGraph into typed IR, standard WGSL, and Native Naga cooker artifacts.
 *
 * Implements authoritative:
 * 1. Identifier & keyword validation
 * 2. Topological sort with cycle & missing-node detection
 * 3. Backward stage usage propagation from entry roots
 * 4. Registry signature matching, port cardinality & port type validation
 * 5. Merkle sub-tree expression caching
 * 6. Vertex clip-space position driving from vertex outputs
 * 7. Standard WGSL emission
 */

import { stableHash } from '../../../core';
import type { ShaderDiagnostic } from '../../types';
import type { BoundedNodeCache } from './cache';
import { emitWgslFromIR } from './emitter';
import { findMatchingSignature, getShaderNodeDefinition } from './registry';
import {
  propagateStageUsage,
  resolveConnectionNodeId,
  topologicalSortGraph
} from './topological-sort';
import type {
  CachedNodeExpression,
  ShaderDataType,
  ShaderGraph,
  ShaderGraphNode,
  ShaderGraphResult,
  ShaderNodeDefinition,
  ShaderPortDefinition,
  ShaderStage,
  TypedGraphIR
} from './types';
import {
  diagnoseSignatureFailure,
  formatWgslLiteral,
  graphDiagnostic,
  validateGraphNodes
} from './validation';

const NO_DIAGNOSTICS: readonly ShaderDiagnostic[] = Object.freeze([]);
const NO_VERTEX_INPUTS: readonly {
  readonly location: number;
  readonly name: string;
  readonly type: ShaderDataType;
}[] = Object.freeze([]);
const NO_FRAGMENT_OUTPUTS: readonly {
  readonly location: number;
  readonly name: string;
  readonly type: ShaderDataType;
}[] = Object.freeze([]);
const NO_UNIFORMS: readonly {
  readonly group: number;
  readonly binding: number;
  readonly varName: string;
  readonly typeName: string;
  readonly fields: readonly { readonly name: string; readonly type: ShaderDataType }[];
}[] = Object.freeze([]);
const NO_TEXTURES: readonly {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
}[] = Object.freeze([]);
const NO_SAMPLERS: readonly {
  readonly group: number;
  readonly binding: number;
  readonly name: string;
}[] = Object.freeze([]);
const NO_STATEMENTS: readonly string[] = Object.freeze([]);

const ARITHMETIC_OPS: Readonly<Record<string, string>> = Object.freeze({
  add: '+',
  subtract: '-',
  sub: '-',
  multiply: '*',
  mul: '*',
  divide: '/',
  div: '/'
});

function getArithmeticOp(kind: string): string {
  return ARITHMETIC_OPS[kind] ?? '+';
}

function pushStatementToStages(
  stmt: string,
  usedStages: ReadonlySet<ShaderStage>,
  vertexStatements: string[],
  fragmentStatements: string[],
  computeStatements: string[]
): void {
  if (usedStages.has('vertex')) vertexStatements.push(stmt);
  if (usedStages.has('compute')) computeStatements.push(stmt);
  if (usedStages.has('fragment') || (!usedStages.has('vertex') && !usedStages.has('compute'))) {
    fragmentStatements.push(stmt);
  }
}

/**
 * Authoritative pipeline lowering a ShaderGraph to TypedGraphIR and standard WGSL.
 */
export function lowerGraphToIR(
  graph: ShaderGraph,
  options?: { nodeCache?: BoundedNodeCache | undefined; signal?: AbortSignal | undefined }
): ShaderGraphResult {
  if (options?.signal?.aborted) {
    return Object.freeze({ ok: false, diagnostics: NO_DIAGNOSTICS, cancelled: true });
  }

  const initialDiag = validateGraphNodes(graph.nodes);
  if (initialDiag) {
    return Object.freeze({ ok: false, diagnostics: Object.freeze([initialDiag]) });
  }

  const vertexAttrNodes = graph.nodes.filter((n) => n.kind === 'vertexAttribute');
  const rootTargets = Array.from(
    new Set([...Object.values(graph.outputs), ...vertexAttrNodes.map((n) => n.id)])
  );
  const topoResult = topologicalSortGraph(graph.nodes, rootTargets);
  if (!topoResult.ok) {
    const code = topoResult.error === 'cycle' ? 'GRAPH_CYCLE' : 'GRAPH_MISSING_NODE';
    const msg =
      topoResult.error === 'cycle'
        ? `ShaderGraph contains a cycle through "${topoResult.nodeId}".`
        : `ShaderGraph references missing node "${topoResult.nodeId}".`;
    return Object.freeze({
      ok: false,
      diagnostics: Object.freeze([graphDiagnostic(code, msg)])
    });
  }

  const stageUsage = propagateStageUsage(graph.nodes, graph.outputs);
  const { order } = topoResult;
  const nodeTypes = new Map<string, ShaderDataType>();
  const nodeOutputPorts = new Map<string, readonly ShaderPortDefinition[]>();
  const nodeHashes = new Map<string, string>();
  let reusedNodes = 0;

  const vertexInputs: { location: number; name: string; type: ShaderDataType }[] = [];
  const fragmentOutputs: { location: number; name: string; type: ShaderDataType }[] = [];
  const uniformFields: { name: string; type: ShaderDataType }[] = [];
  const textures: { group: number; binding: number; name: string }[] = [];
  const samplers: { group: number; binding: number; name: string }[] = [];

  const vertexStatements: string[] = [];
  const fragmentStatements: string[] = [];
  const computeStatements: string[] = [];

  for (const node of order) {
    if (options?.signal?.aborted) {
      return Object.freeze({ ok: false, diagnostics: NO_DIAGNOSTICS, cancelled: true });
    }

    const definition = getShaderNodeDefinition(node.kind)!;
    const usedStages = stageUsage.get(node.id) ?? new Set<ShaderStage>();

    const providedInputs: Record<string, ShaderDataType> = {};
    for (const [portId, conn] of Object.entries(node.inputs ?? {})) {
      const sourceId = resolveConnectionNodeId(conn);
      const sourceType = nodeTypes.get(sourceId);
      if (!sourceType) {
        return Object.freeze({
          ok: false,
          diagnostics: Object.freeze([
            graphDiagnostic(
              'GRAPH_MISSING_NODE',
              `Node "${node.id}" references uncomputed or missing node "${sourceId}".`
            )
          ])
        });
      }

      let resolvedPortType = sourceType;
      if (typeof conn !== 'string' && conn.portId !== undefined) {
        const sourceOutputs = nodeOutputPorts.get(sourceId) ?? [];
        const matchedPort = sourceOutputs.find((p) => p.id === conn.portId);
        if (!matchedPort) {
          return Object.freeze({
            ok: false,
            diagnostics: Object.freeze([
              graphDiagnostic(
                'GRAPH_INVALID_PORT',
                `Node "${node.id}" references non-existent output port "${conn.portId}" on node "${sourceId}".`
              )
            ])
          });
        }
        resolvedPortType = matchedPort.type;
      }
      providedInputs[portId] = resolvedPortType;
    }

    const matchedSig = findMatchingSignature(
      definition,
      providedInputs,
      usedStages,
      node.outputType
    );
    if (!matchedSig) {
      return Object.freeze({
        ok: false,
        diagnostics: Object.freeze([
          diagnoseSignatureFailure(node, definition, providedInputs, usedStages)
        ])
      });
    }

    nodeOutputPorts.set(node.id, matchedSig.outputs);

    const resolvedOutputType: ShaderDataType =
      matchedSig.outputs.length > 0
        ? matchedSig.outputs[0]!.type
        : ((node.outputType as ShaderDataType) ?? 'vec4f');

    if (node.outputType !== undefined && node.outputType !== resolvedOutputType) {
      return Object.freeze({
        ok: false,
        diagnostics: Object.freeze([
          graphDiagnostic(
            'GRAPH_TYPE_MISMATCH',
            `Node "${node.id}" declared output type "${node.outputType}" does not match signature output type "${resolvedOutputType}".`
          )
        ])
      });
    }
    nodeTypes.set(node.id, resolvedOutputType);

    let literal: string | undefined;
    if (node.kind === 'constant') {
      const litRes = formatWgslLiteral(node.value, resolvedOutputType);
      if (!litRes.ok) {
        return Object.freeze({
          ok: false,
          diagnostics: Object.freeze([
            graphDiagnostic('GRAPH_INVALID_LITERAL', `Node "${node.id}": ${litRes.message}`)
          ])
        });
      }
      literal = litRes.literal;
    }

    const nodeHash = stableHash({
      kind: node.kind,
      outputType: resolvedOutputType,
      dependencies: Object.entries(node.inputs ?? {})
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, conn]) => [name, nodeHashes.get(resolveConnectionNodeId(conn))]),
      value: node.value
    });
    nodeHashes.set(node.id, nodeHash);

    let cachedStatement: string | undefined;
    if (options?.nodeCache) {
      const cached = options.nodeCache.get(nodeHash);
      if (cached !== undefined) {
        reusedNodes++;
        if (cached.nodeId === node.id && cached.statement) {
          cachedStatement = cached.statement;
        } else if (cached.literal !== undefined) {
          literal = cached.literal;
        }
      }
    }

    if (node.kind === 'vertexAttribute') {
      const loc = node.location ?? vertexInputs.length;
      vertexInputs.push({ location: loc, name: node.id, type: resolvedOutputType });
      const stmt = cachedStatement ?? `let ${node.id}: ${resolvedOutputType} = input.${node.id};`;
      if (options?.nodeCache && cachedStatement === undefined) {
        options.nodeCache.set(
          nodeHash,
          Object.freeze({
            outputType: resolvedOutputType,
            op: node.kind,
            nodeId: node.id,
            statement: stmt
          })
        );
      }
      vertexStatements.push(stmt);
      continue;
    }

    if (node.kind === 'parameter') {
      if (resolvedOutputType === 'texture_2d<f32>') {
        textures.push({ group: node.group ?? 1, binding: node.binding ?? 0, name: node.id });
      } else if (resolvedOutputType === 'sampler' || resolvedOutputType === 'sampler_comparison') {
        samplers.push({ group: node.group ?? 1, binding: node.binding ?? 1, name: node.id });
      } else {
        uniformFields.push({ name: node.id, type: resolvedOutputType });
        const stmt =
          cachedStatement ?? `let ${node.id}: ${resolvedOutputType} = materialParams.${node.id};`;
        if (options?.nodeCache && cachedStatement === undefined) {
          options.nodeCache.set(
            nodeHash,
            Object.freeze({
              outputType: resolvedOutputType,
              op: node.kind,
              nodeId: node.id,
              statement: stmt
            })
          );
        }
        pushStatementToStages(
          stmt,
          usedStages,
          vertexStatements,
          fragmentStatements,
          computeStatements
        );
      }
      continue;
    }

    if (node.kind === 'fragmentOutput') {
      const colorId = resolveConnectionNodeId(node.inputs?.color ?? '');
      fragmentOutputs.push({ location: 0, name: node.id, type: 'vec4f' });
      const stmt = cachedStatement ?? `let ${node.id}: vec4f = ${colorId};`;
      if (options?.nodeCache && cachedStatement === undefined) {
        options.nodeCache.set(
          nodeHash,
          Object.freeze({
            outputType: resolvedOutputType,
            op: node.kind,
            nodeId: node.id,
            statement: stmt
          })
        );
      }
      fragmentStatements.push(stmt);
      continue;
    }

    // Pure computation nodes: constant, textureSample, vec4f_from_vec3f, arithmetic
    let stmt: string;
    if (cachedStatement !== undefined) {
      stmt = cachedStatement;
    } else if (node.kind === 'constant') {
      stmt = `let ${node.id}: ${resolvedOutputType} = ${literal};`;
    } else if (node.kind === 'textureSample') {
      const tex = resolveConnectionNodeId(node.inputs?.texture ?? '');
      const smp = resolveConnectionNodeId(node.inputs?.sampler ?? '');
      const uv = resolveConnectionNodeId(node.inputs?.uv ?? '');
      stmt = `let ${node.id}: vec4f = textureSample(${tex}, ${smp}, ${uv});`;
    } else if (node.kind === 'vec4f_from_vec3f') {
      const rgb = resolveConnectionNodeId(node.inputs?.rgb ?? '');
      const alpha = resolveConnectionNodeId(node.inputs?.alpha ?? '');
      stmt = `let ${node.id}: vec4f = vec4f(${rgb}, ${alpha});`;
    } else {
      const leftId = resolveConnectionNodeId(node.inputs?.left ?? '');
      const rightId = resolveConnectionNodeId(node.inputs?.right ?? '');
      const op = getArithmeticOp(node.kind);
      stmt = `let ${node.id}: ${resolvedOutputType} = ${leftId} ${op} ${rightId};`;
    }

    if (options?.nodeCache && cachedStatement === undefined) {
      options.nodeCache.set(
        nodeHash,
        Object.freeze({
          outputType: resolvedOutputType,
          op: node.kind,
          nodeId: node.id,
          statement: stmt,
          ...(literal !== undefined ? { literal } : {})
        })
      );
    }

    if (node.kind === 'textureSample') {
      fragmentStatements.push(stmt);
    } else {
      pushStatementToStages(
        stmt,
        usedStages,
        vertexStatements,
        fragmentStatements,
        computeStatements
      );
    }
  }

  let vertexReturnExpr = '';
  let vertexReturnType: ShaderDataType = 'vec4f';
  if (graph.outputs.vertex) {
    const vId = resolveConnectionNodeId(graph.outputs.vertex);
    vertexReturnExpr = vId;
    vertexReturnType = nodeTypes.get(vId) ?? 'vec4f';
  }

  let fragmentReturnExpr = '';
  let fragmentReturnType: ShaderDataType = 'vec4f';
  if (graph.outputs.fragment) {
    const fId = resolveConnectionNodeId(graph.outputs.fragment);
    fragmentReturnExpr = fId;
    fragmentReturnType = nodeTypes.get(fId) ?? 'vec4f';
  }

  const uniforms =
    uniformFields.length > 0
      ? [
          Object.freeze({
            group: 0,
            binding: 0,
            varName: 'materialParams',
            typeName: 'MaterialParams',
            fields: Object.freeze(uniformFields)
          })
        ]
      : NO_UNIFORMS;

  const ir: TypedGraphIR = Object.freeze({
    vertexInputs: vertexInputs.length > 0 ? Object.freeze(vertexInputs) : NO_VERTEX_INPUTS,
    fragmentOutputs:
      fragmentOutputs.length > 0 ? Object.freeze(fragmentOutputs) : NO_FRAGMENT_OUTPUTS,
    uniforms: Object.freeze(uniforms),
    textures: textures.length > 0 ? Object.freeze(textures) : NO_TEXTURES,
    samplers: samplers.length > 0 ? Object.freeze(samplers) : NO_SAMPLERS,
    vertexStatements: vertexStatements.length > 0 ? Object.freeze(vertexStatements) : NO_STATEMENTS,
    fragmentStatements:
      fragmentStatements.length > 0 ? Object.freeze(fragmentStatements) : NO_STATEMENTS,
    computeStatements:
      computeStatements.length > 0 ? Object.freeze(computeStatements) : NO_STATEMENTS,
    vertexReturnExpr,
    vertexReturnType,
    fragmentReturnExpr,
    fragmentReturnType
  });

  const wgsl = emitWgslFromIR(ir);
  const hasCompute = Boolean(graph.outputs.compute);
  const hasGraphics = Boolean(graph.outputs.vertex || graph.outputs.fragment || !hasCompute);
  const entryPoints: { name: string; stage: string }[] = [];
  if (hasGraphics) {
    entryPoints.push({ name: 'vertexMain', stage: 'vertex' });
    entryPoints.push({ name: 'fragmentMain', stage: 'fragment' });
  }
  if (hasCompute) {
    entryPoints.push({ name: 'computeMain', stage: 'compute' });
  }
  const metadataJson = JSON.stringify(
    {
      schemaVersion: 1,
      entryPoints
    },
    null,
    2
  );

  return Object.freeze({
    ok: true,
    revision: graph.revision,
    ir,
    wgsl,
    metadataJson,
    reusedNodes,
    sourceHash: stableHash({ nodes: graph.nodes, outputs: graph.outputs })
  });
}

export { emitWgslFromIR } from './emitter';

/**
 * Convenience entry point to typecheck and lower a ShaderGraph into TypedGraphIR and standard WGSL.
 */
export function lowerVerticalSliceGraph(graph: ShaderGraph): ShaderGraphResult {
  return lowerGraphToIR(graph);
}
