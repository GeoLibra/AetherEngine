/**
 * @file ShaderGraph DAG compiler lowering typed node expressions into standard WGSL code.
 */

import { stableHash } from '../../../core';
import type { ShaderDiagnostic } from '../../types';
import { BoundedNodeCache } from './cache';
import { getShaderNodeDefinition } from './registry';
import { resolveConnectionNodeId, topologicalSortGraph } from './topological-sort';
import type {
  CachedNodeExpression,
  ShaderDataType,
  ShaderGraph,
  ShaderGraphNode,
  ShaderGraphResult,
  ShaderStage
} from './types';
import {
  formatReturnExpression,
  formatWgslLiteral,
  graphDiagnostic,
  isValidWgslIdentifier
} from './validation';

const NO_SHADER_DIAGNOSTICS: readonly ShaderDiagnostic[] = Object.freeze([]);

/**
 * Compiles a strongly typed visual ShaderGraph DAG into standard WGSL shader source code.
 */
export class ShaderGraphCompiler {
  private readonly nodeCache: BoundedNodeCache;

  constructor(options?: { cacheCapacity?: number }) {
    this.nodeCache = new BoundedNodeCache(options?.cacheCapacity ?? 1024);
  }

  /**
   * Validates graph topology, node types, and lowers nodes into standard WGSL.
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

      const definition = getShaderNodeDefinition(node.kind);
      if (!definition) {
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

      // Check port cardinality against definition
      const inputKeys = Object.keys(node.inputs ?? {});
      if (definition.signatures.length > 0) {
        const anySigInputs = definition.signatures[0]!.inputs;
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
        if (anySigInputs.length > 0) {
          const expectedPortIds = new Set(anySigInputs.map((p) => p.id));
          for (const key of inputKeys) {
            if (!expectedPortIds.has(key)) {
              return Object.freeze({
                ok: false,
                diagnostics: Object.freeze([
                  graphDiagnostic(
                    'GRAPH_INVALID_PORT',
                    `Node "${node.id}" received unexpected input port "${key}".`
                  )
                ])
              });
            }
          }
          if (inputKeys.length !== expectedPortIds.size) {
            return Object.freeze({
              ok: false,
              diagnostics: Object.freeze([
                graphDiagnostic(
                  'GRAPH_INVALID_PORT',
                  `Node "${node.id}" of kind "${node.kind}" requires ${expectedPortIds.size} input port(s), received ${inputKeys.length}.`
                )
              ])
            });
          }
        }
      }

      seenIds.add(node.id);
    }

    const rootTargets = Object.values(graph.outputs);
    const topoResult = topologicalSortGraph(graph.nodes, rootTargets);
    if (!topoResult.ok) {
      if (topoResult.error === 'cycle') {
        return Object.freeze({
          ok: false,
          diagnostics: Object.freeze([
            graphDiagnostic(
              'GRAPH_CYCLE',
              `ShaderGraph contains a cycle through "${topoResult.nodeId}".`
            )
          ])
        });
      }
      return Object.freeze({
        ok: false,
        diagnostics: Object.freeze([
          graphDiagnostic(
            'GRAPH_MISSING_NODE',
            `ShaderGraph references missing node "${topoResult.nodeId}".`
          )
        ])
      });
    }

    const { order } = topoResult;
    const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
    const nodeTypes = new Map<string, ShaderDataType>();
    const nodeStages = new Map<string, ShaderStage>();

    // Determine entry point stages
    const entryStages = new Set<ShaderStage>(Object.keys(graph.outputs) as ShaderStage[]);

    let reusedNodes = 0;
    const statements = new Map<string, string>();
    const nodeHashes = new Map<string, string>();

    for (const node of order) {
      if (signal?.aborted) {
        return Object.freeze({ ok: false, cancelled: true, diagnostics: NO_SHADER_DIAGNOSTICS });
      }

      const definition = getShaderNodeDefinition(node.kind)!;
      const inputs = node.inputs ?? {};

      // Stage isolation check
      const allowedStages = new Set(definition.signatures.map((s) => s.stage));
      if (!allowedStages.has('all')) {
        for (const stage of entryStages) {
          if (!allowedStages.has(stage)) {
            return Object.freeze({
              ok: false,
              diagnostics: Object.freeze([
                graphDiagnostic(
                  'GRAPH_STAGE_MISMATCH',
                  `Node "${node.id}" of kind "${node.kind}" is not valid in "${stage}" stage.`
                )
              ])
            });
          }
        }
      }

      // Check input types and type mismatch
      const resolvedInputTypes: Record<string, ShaderDataType> = {};
      for (const [portId, connection] of Object.entries(inputs)) {
        const sourceId = resolveConnectionNodeId(connection);
        const sourceNode = nodeMap.get(sourceId);
        const sourceType =
          (sourceNode?.outputType as ShaderDataType | undefined) ?? nodeTypes.get(sourceId);

        if (sourceType) {
          resolvedInputTypes[portId] = sourceType;
          if (node.outputType && sourceType !== node.outputType && isArithmeticKind(node.kind)) {
            return Object.freeze({
              ok: false,
              diagnostics: Object.freeze([
                graphDiagnostic(
                  'GRAPH_TYPE_MISMATCH',
                  `Node "${node.id}" expects ${node.outputType} but "${sourceId}" produces ${sourceType}.`
                )
              ])
            });
          }
        }
      }

      // Determine output type
      let resolvedOutputType = (node.outputType as ShaderDataType | undefined) ?? 'vec4f';
      if (node.kind === 'constant') {
        resolvedOutputType = (node.outputType as ShaderDataType | undefined) ?? 'f32';
      } else if (isArithmeticKind(node.kind)) {
        resolvedOutputType =
          (node.outputType as ShaderDataType | undefined) ?? resolvedInputTypes.left ?? 'f32';
      } else if (node.kind === 'textureSample' || node.kind === 'vec4f_from_vec3f') {
        resolvedOutputType = 'vec4f';
      }
      nodeTypes.set(node.id, resolvedOutputType);

      let op = node.kind;
      let literal: string | undefined;

      if (node.kind === 'constant') {
        const litRes = formatWgslLiteral(node.value, resolvedOutputType);
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
      }

      const hash = stableHash({
        kind: node.kind,
        outputType: resolvedOutputType,
        dependencies: Object.entries(inputs)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, conn]) => [name, nodeHashes.get(resolveConnectionNodeId(conn))]),
        value: node.value
      });
      nodeHashes.set(node.id, hash);

      const cached = this.nodeCache.get(hash);
      if (cached !== undefined) {
        reusedNodes++;
        const expr = formatNodeExpression(cached.op, inputs, cached.literal);
        statements.set(node.id, `let ${node.id}: ${resolvedOutputType} = ${expr};`);
        continue;
      }

      const expr = formatNodeExpression(op, inputs, literal);
      const cachedEntry: CachedNodeExpression = Object.freeze({
        outputType: resolvedOutputType,
        op,
        ...(literal !== undefined ? { literal } : {})
      });
      this.nodeCache.set(hash, cachedEntry);
      statements.set(node.id, `let ${node.id}: ${resolvedOutputType} = ${expr};`);
    }

    const bodyLines = order.map((node) => `  ${statements.get(node.id)!}`).join('\n');

    const entryPointBlocks: string[] = [];
    for (const [stage, outputTarget] of Object.entries(graph.outputs)) {
      const outputId = resolveConnectionNodeId(outputTarget);
      const outputNode = nodeMap.get(outputId);
      const outputType = outputNode?.outputType ?? nodeTypes.get(outputId) ?? 'vec4f';
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

function isArithmeticKind(kind: string): boolean {
  return (
    kind === 'add' ||
    kind === 'subtract' ||
    kind === 'sub' ||
    kind === 'multiply' ||
    kind === 'mul' ||
    kind === 'divide' ||
    kind === 'div'
  );
}

function formatNodeExpression(
  op: string,
  inputs: Readonly<Record<string, unknown>> | undefined,
  literal: string | undefined
): string {
  if (op === 'constant') {
    return literal ?? '0.0';
  }
  const left = resolveConnectionNodeId((inputs?.left ?? '') as any);
  const right = resolveConnectionNodeId((inputs?.right ?? '') as any);
  if (op === 'add') {
    return `${left} + ${right}`;
  }
  if (op === 'subtract' || op === 'sub') {
    return `${left} - ${right}`;
  }
  if (op === 'multiply' || op === 'mul') {
    return `${left} * ${right}`;
  }
  if (op === 'divide' || op === 'div') {
    return `${left} / ${right}`;
  }
  if (op === 'textureSample') {
    const tex = resolveConnectionNodeId((inputs?.texture ?? '') as any);
    const smp = resolveConnectionNodeId((inputs?.sampler ?? '') as any);
    const uv = resolveConnectionNodeId((inputs?.uv ?? '') as any);
    return `textureSample(${tex}, ${smp}, ${uv})`;
  }
  if (op === 'vec4f_from_vec3f') {
    const rgb = resolveConnectionNodeId((inputs?.rgb ?? '') as any);
    const alpha = resolveConnectionNodeId((inputs?.alpha ?? '') as any);
    return `vec4f(${rgb}, ${alpha})`;
  }
  return '0.0';
}
