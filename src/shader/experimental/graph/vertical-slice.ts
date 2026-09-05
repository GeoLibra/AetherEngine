/**
 * @file Minimal vertical slice lowering ShaderGraph to typed IR, standard WGSL, and native Naga cooker.
 *
 * Supported core nodes:
 * 1. constant (scalar/vector literals)
 * 2. parameter (uniform buffer declaration & access)
 * 3. add / multiply (typed arithmetic)
 * 4. textureSample (texture_2d<f32> + sampler + uv -> vec4f)
 * 5. vertexAttribute (@location(N) vertex input)
 * 6. fragmentOutput (@location(0) fragment color)
 */

import type { ShaderDiagnostic } from '../../types';
import { resolveConnectionNodeId, topologicalSortGraph } from './topological-sort';
import type { ShaderDataType, ShaderGraph } from './types';
import { formatWgslLiteral, graphDiagnostic, isValidWgslIdentifier } from './validation';

const VERTICAL_SLICE_KINDS = new Set([
  'constant',
  'parameter',
  'add',
  'multiply',
  'textureSample',
  'vertexAttribute',
  'fragmentOutput'
]);

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
  readonly fragmentReturnExpr: string;
}

export type VerticalSliceLowerResult =
  | Readonly<{ ok: true; ir: TypedGraphIR; wgsl: string; metadataJson: string }>
  | Readonly<{ ok: false; diagnostics: readonly ShaderDiagnostic[] }>;

/**
 * Typechecks and lowers a minimal ShaderGraph DAG into typed IR and standard WGSL.
 */
export function lowerVerticalSliceGraph(graph: ShaderGraph): VerticalSliceLowerResult {
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
    if (!VERTICAL_SLICE_KINDS.has(node.kind)) {
      return Object.freeze({
        ok: false,
        diagnostics: Object.freeze([
          graphDiagnostic(
            'GRAPH_UNKNOWN_NODE_TYPE',
            `Node type "${node.kind}" is not supported in the minimal vertical slice.`
          )
        ])
      });
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

  const { order } = topoResult;
  const nodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const nodeTypes = new Map<string, ShaderDataType>();

  const vertexInputs: { location: number; name: string; type: ShaderDataType }[] = [];
  const fragmentOutputs: { location: number; name: string; type: ShaderDataType }[] = [];
  const uniformFields: { name: string; type: ShaderDataType }[] = [];
  const textures: { group: number; binding: number; name: string }[] = [];
  const samplers: { group: number; binding: number; name: string }[] = [];

  const vertexStatements: string[] = [];
  const fragmentStatements: string[] = [];

  for (const node of order) {
    const inputs = node.inputs ?? {};

    if (node.kind === 'vertexAttribute') {
      const type = (node.outputType as ShaderDataType) ?? 'vec3f';
      const loc = node.location ?? vertexInputs.length;
      vertexInputs.push({ location: loc, name: node.id, type });
      nodeTypes.set(node.id, type);
      vertexStatements.push(`let ${node.id}: ${type} = input.${node.id};`);
      continue;
    }

    if (node.kind === 'parameter') {
      const type = (node.outputType as ShaderDataType) ?? 'vec4f';
      nodeTypes.set(node.id, type);
      if (type === 'texture_2d<f32>') {
        textures.push({ group: node.group ?? 1, binding: node.binding ?? 0, name: node.id });
      } else if (type === 'sampler' || type === 'sampler_comparison') {
        samplers.push({ group: node.group ?? 1, binding: node.binding ?? 1, name: node.id });
      } else {
        uniformFields.push({ name: node.id, type });
        fragmentStatements.push(`let ${node.id}: ${type} = materialParams.${node.id};`);
      }
      continue;
    }

    if (node.kind === 'constant') {
      const type = (node.outputType as ShaderDataType) ?? 'f32';
      const litRes = formatWgslLiteral(node.value, type);
      if (!litRes.ok) {
        return Object.freeze({
          ok: false,
          diagnostics: Object.freeze([
            graphDiagnostic('GRAPH_INVALID_LITERAL', `Node "${node.id}": ${litRes.message}`)
          ])
        });
      }
      nodeTypes.set(node.id, type);
      fragmentStatements.push(`let ${node.id}: ${type} = ${litRes.literal};`);
      continue;
    }

    if (node.kind === 'add' || node.kind === 'multiply') {
      const leftId = resolveConnectionNodeId(inputs.left ?? '');
      const rightId = resolveConnectionNodeId(inputs.right ?? '');
      const leftType = nodeTypes.get(leftId) ?? 'f32';
      const rightType = nodeTypes.get(rightId) ?? 'f32';

      let outType: ShaderDataType = leftType;
      if (leftType !== rightType) {
        if (node.kind === 'multiply' && (rightType === 'f32' || leftType === 'f32')) {
          outType = leftType === 'f32' ? rightType : leftType;
        } else {
          return Object.freeze({
            ok: false,
            diagnostics: Object.freeze([
              graphDiagnostic(
                'GRAPH_TYPE_MISMATCH',
                `Node "${node.id}" type mismatch: ${leftType} and ${rightType}.`
              )
            ])
          });
        }
      }
      nodeTypes.set(node.id, outType);
      const op = node.kind === 'add' ? '+' : '*';
      fragmentStatements.push(`let ${node.id}: ${outType} = ${leftId} ${op} ${rightId};`);
      continue;
    }

    if (node.kind === 'textureSample') {
      const tex = resolveConnectionNodeId(inputs.texture ?? '');
      const smp = resolveConnectionNodeId(inputs.sampler ?? '');
      const uv = resolveConnectionNodeId(inputs.uv ?? '');
      nodeTypes.set(node.id, 'vec4f');
      fragmentStatements.push(`let ${node.id}: vec4f = textureSample(${tex}, ${smp}, ${uv});`);
      continue;
    }

    if (node.kind === 'fragmentOutput') {
      const colorId = resolveConnectionNodeId(inputs.color ?? '');
      nodeTypes.set(node.id, 'vec4f');
      fragmentOutputs.push({ location: 0, name: node.id, type: 'vec4f' });
      fragmentStatements.push(`let ${node.id}: vec4f = ${colorId};`);
      continue;
    }
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
      : [];

  const fragOutId = resolveConnectionNodeId(graph.outputs.fragment ?? 'color');
  const fragRetNode = nodeMap.get(fragOutId);
  const fragRetType = fragRetNode?.outputType ?? nodeTypes.get(fragOutId) ?? 'vec4f';

  const ir: TypedGraphIR = Object.freeze({
    vertexInputs: Object.freeze(vertexInputs),
    fragmentOutputs: Object.freeze(fragmentOutputs),
    uniforms: Object.freeze(uniforms),
    textures: Object.freeze(textures),
    samplers: Object.freeze(samplers),
    vertexStatements: Object.freeze(vertexStatements),
    fragmentStatements: Object.freeze(fragmentStatements),
    fragmentReturnExpr: fragOutId
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
    ir,
    wgsl,
    metadataJson
  });
}

function emitWgslFromIR(ir: TypedGraphIR): string {
  const sections: string[] = [];

  // Uniform structs
  for (const u of ir.uniforms) {
    const fieldsStr = u.fields.map((f) => `  ${f.name}: ${f.type},`).join('\n');
    sections.push(`struct ${u.typeName} {\n${fieldsStr}\n};`);
    sections.push(
      `@group(${u.group}) @binding(${u.binding}) var<uniform> ${u.varName}: ${u.typeName};`
    );
  }

  // Textures and Samplers
  for (const t of ir.textures) {
    sections.push(`@group(${t.group}) @binding(${t.binding}) var ${t.name}: texture_2d<f32>;`);
  }
  for (const s of ir.samplers) {
    sections.push(`@group(${s.group}) @binding(${s.binding}) var ${s.name}: sampler;`);
  }

  // Vertex IO
  const vInputFields =
    ir.vertexInputs.length > 0
      ? ir.vertexInputs.map((i) => `  @location(${i.location}) ${i.name}: ${i.type},`).join('\n')
      : '  @location(0) position: vec3f,';
  sections.push(`struct VertexInput {\n${vInputFields}\n};`);

  sections.push(
    `struct VertexOutput {\n  @builtin(position) position: vec4f,\n  @location(0) uv: vec2f,\n};`
  );

  // Vertex Main
  const vBody =
    ir.vertexStatements.length > 0 ? ir.vertexStatements.map((s) => `  ${s}`).join('\n') : '';
  sections.push(
    `@vertex\nfn vertexMain(input: VertexInput) -> VertexOutput {\n  var output: VertexOutput;\n${vBody}\n  output.position = vec4f(input.position.xy, 0.0, 1.0);\n  output.uv = vec2f(0.5, 0.5);\n  return output;\n}`
  );

  // Fragment Main
  const fBody = ir.fragmentStatements.map((s) => `  ${s}`).join('\n');
  sections.push(
    `@fragment\nfn fragmentMain(stageInput: VertexOutput) -> @location(0) vec4f {\n${fBody}\n  return ${ir.fragmentReturnExpr};\n}`
  );

  return sections.join('\n\n');
}
