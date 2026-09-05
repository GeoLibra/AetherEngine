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
  ShaderStage,
  TypedGraphIR
} from './types';
import { formatWgslLiteral, graphDiagnostic, isValidWgslIdentifier } from './validation';

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

function getArithmeticOp(kind: string): string {
  switch (kind) {
    case 'add':
      return '+';
    case 'subtract':
    case 'sub':
      return '-';
    case 'multiply':
    case 'mul':
      return '*';
    case 'divide':
    case 'div':
      return '/';
    default:
      return '+';
  }
}

function diagnoseSignatureFailure(
  node: ShaderGraphNode,
  definition: ShaderNodeDefinition,
  providedInputs: Readonly<Record<string, ShaderDataType>>,
  usedStages: ReadonlySet<ShaderStage>
): ShaderDiagnostic {
  // Check if failure is due to stage mismatch
  const allSigStages = new Set(definition.signatures.map((s) => s.stage));
  if (!allSigStages.has('all')) {
    for (const stage of usedStages) {
      if (!allSigStages.has(stage)) {
        return graphDiagnostic(
          'GRAPH_STAGE_MISMATCH',
          `Node "${node.id}" of kind "${node.kind}" is not valid in "${stage}" stage.`
        );
      }
    }
  }

  // Check port names
  const allPortIds = new Set(definition.signatures.flatMap((s) => s.inputs.map((p) => p.id)));
  for (const inputKey of Object.keys(providedInputs)) {
    if (!allPortIds.has(inputKey)) {
      return graphDiagnostic(
        'GRAPH_INVALID_PORT',
        `Node "${node.id}" received unexpected input port "${inputKey}".`
      );
    }
  }

  // Check missing ports
  for (const sig of definition.signatures) {
    if (sig.inputs.length > 0 && Object.keys(providedInputs).length < sig.inputs.length) {
      for (const requiredPort of sig.inputs) {
        if (!(requiredPort.id in providedInputs)) {
          return graphDiagnostic(
            'GRAPH_MISSING_PORT',
            `Node "${node.id}" of kind "${node.kind}" is missing required input port "${requiredPort.id}".`
          );
        }
      }
    }
  }

  // Check port types
  return graphDiagnostic(
    'GRAPH_TYPE_MISMATCH',
    `Node "${node.id}" received incompatible port types: ${Object.entries(providedInputs)
      .map(([k, v]) => `${k}: ${v}`)
      .join(', ')}.`
  );
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
    const def = getShaderNodeDefinition(node.kind);
    if (!def) {
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

    const inputKeys = Object.keys(node.inputs ?? {});
    if (def.signatures.length > 0) {
      const anySigInputs = def.signatures[0]!.inputs;
      if (anySigInputs.length === 0 && inputKeys.length > 0) {
        return Object.freeze({
          ok: false,
          diagnostics: Object.freeze([
            graphDiagnostic(
              'GRAPH_INVALID_PORT',
              `Node "${node.id}" of kind "${node.kind}" must not have inputs.`
            )
          ])
        });
      }
      const allPortIds = new Set(def.signatures.flatMap((s) => s.inputs.map((p) => p.id)));
      for (const inputKey of inputKeys) {
        if (!allPortIds.has(inputKey)) {
          return Object.freeze({
            ok: false,
            diagnostics: Object.freeze([
              graphDiagnostic(
                'GRAPH_INVALID_PORT',
                `Node "${node.id}" received unexpected input port "${inputKey}".`
              )
            ])
          });
        }
      }
    }

    seenIds.add(node.id);
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
  const nodeHashes = new Map<string, string>();
  let reusedNodes = 0;

  const vertexInputs: { location: number; name: string; type: ShaderDataType }[] = [];
  const fragmentOutputs: { location: number; name: string; type: ShaderDataType }[] = [];
  const uniformFields: { name: string; type: ShaderDataType }[] = [];
  const textures: { group: number; binding: number; name: string }[] = [];
  const samplers: { group: number; binding: number; name: string }[] = [];

  const vertexStatements: string[] = [];
  const fragmentStatements: string[] = [];

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
      providedInputs[portId] = sourceType;
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

    if (options?.nodeCache) {
      const cached = options.nodeCache.get(nodeHash);
      if (cached !== undefined) {
        reusedNodes++;
      } else {
        const cachedEntry: CachedNodeExpression = Object.freeze({
          outputType: resolvedOutputType,
          op: node.kind,
          ...(literal !== undefined ? { literal } : {})
        });
        options.nodeCache.set(nodeHash, cachedEntry);
      }
    }

    if (node.kind === 'vertexAttribute') {
      const loc = node.location ?? vertexInputs.length;
      vertexInputs.push({ location: loc, name: node.id, type: resolvedOutputType });
      vertexStatements.push(`let ${node.id}: ${resolvedOutputType} = input.${node.id};`);
      continue;
    }

    if (node.kind === 'parameter') {
      if (resolvedOutputType === 'texture_2d<f32>') {
        textures.push({ group: node.group ?? 1, binding: node.binding ?? 0, name: node.id });
      } else if (resolvedOutputType === 'sampler' || resolvedOutputType === 'sampler_comparison') {
        samplers.push({ group: node.group ?? 1, binding: node.binding ?? 1, name: node.id });
      } else {
        uniformFields.push({ name: node.id, type: resolvedOutputType });
        const stmt = `let ${node.id}: ${resolvedOutputType} = materialParams.${node.id};`;
        if (usedStages.has('vertex')) vertexStatements.push(stmt);
        if (usedStages.has('fragment') || usedStages.size === 0) fragmentStatements.push(stmt);
      }
      continue;
    }

    if (node.kind === 'constant') {
      const stmt = `let ${node.id}: ${resolvedOutputType} = ${literal};`;
      if (usedStages.has('vertex')) vertexStatements.push(stmt);
      if (usedStages.has('fragment') || usedStages.size === 0) fragmentStatements.push(stmt);
      continue;
    }

    if (node.kind === 'fragmentOutput') {
      const colorId = resolveConnectionNodeId(node.inputs?.color ?? '');
      fragmentOutputs.push({ location: 0, name: node.id, type: 'vec4f' });
      fragmentStatements.push(`let ${node.id}: vec4f = ${colorId};`);
      continue;
    }

    if (node.kind === 'textureSample') {
      const tex = resolveConnectionNodeId(node.inputs?.texture ?? '');
      const smp = resolveConnectionNodeId(node.inputs?.sampler ?? '');
      const uv = resolveConnectionNodeId(node.inputs?.uv ?? '');
      fragmentStatements.push(`let ${node.id}: vec4f = textureSample(${tex}, ${smp}, ${uv});`);
      continue;
    }

    if (node.kind === 'vec4f_from_vec3f') {
      const rgb = resolveConnectionNodeId(node.inputs?.rgb ?? '');
      const alpha = resolveConnectionNodeId(node.inputs?.alpha ?? '');
      const stmt = `let ${node.id}: vec4f = vec4f(${rgb}, ${alpha});`;
      if (usedStages.has('vertex')) vertexStatements.push(stmt);
      if (usedStages.has('fragment') || usedStages.size === 0) fragmentStatements.push(stmt);
      continue;
    }

    const leftId = resolveConnectionNodeId(node.inputs?.left ?? '');
    const rightId = resolveConnectionNodeId(node.inputs?.right ?? '');
    const op = getArithmeticOp(node.kind);
    const stmt = `let ${node.id}: ${resolvedOutputType} = ${leftId} ${op} ${rightId};`;
    if (usedStages.has('vertex')) vertexStatements.push(stmt);
    if (usedStages.has('fragment') || usedStages.size === 0) fragmentStatements.push(stmt);
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
    vertexReturnExpr,
    vertexReturnType,
    fragmentReturnExpr,
    fragmentReturnType
  });

  const wgsl = emitWgslFromIR(ir);
  const metadataJson = JSON.stringify(
    {
      schemaVersion: 1,
      entryPoints: [
        { name: 'vertexMain', stage: 'vertex' },
        { name: 'fragmentMain', stage: 'fragment' }
      ]
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
