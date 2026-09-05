/**
 * @file Pure standard WGSL shader emitter for TypedGraphIR.
 */

import type { TypedGraphIR } from './types';

/**
 * Pure function lowering TypedGraphIR into standard WGSL shader source code.
 */
export function emitWgslFromIR(ir: TypedGraphIR): string {
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

  // Determine vertex position expression
  let posExpr: string;
  if (ir.vertexReturnExpr) {
    switch (ir.vertexReturnType) {
      case 'vec4f':
        posExpr = ir.vertexReturnExpr;
        break;
      case 'vec3f':
        posExpr = `vec4f(${ir.vertexReturnExpr}, 1.0)`;
        break;
      case 'vec2f':
        posExpr = `vec4f(${ir.vertexReturnExpr}, 0.0, 1.0)`;
        break;
      default:
        posExpr = `vec4f(${ir.vertexReturnExpr}, 0.0, 0.0, 1.0)`;
        break;
    }
  } else {
    posExpr = 'vec4f(0.0, 0.0, 0.0, 1.0)';
  }

  // Vertex Main
  const vBody =
    ir.vertexStatements.length > 0
      ? ir.vertexStatements.map((s) => `  ${s}`).join('\n') + '\n'
      : '';
  sections.push(
    `@vertex\nfn vertexMain(input: VertexInput) -> VertexOutput {\n  var output: VertexOutput;\n${vBody}  output.position = ${posExpr};\n  output.uv = vec2f(0.5, 0.5);\n  return output;\n}`
  );

  // Fragment Main
  const fBody =
    ir.fragmentStatements.length > 0
      ? ir.fragmentStatements.map((s) => `  ${s}`).join('\n') + '\n'
      : '';
  const fReturnExpr = ir.fragmentReturnExpr || 'vec4f(0.0, 0.0, 0.0, 1.0)';
  sections.push(
    `@fragment\nfn fragmentMain(stageInput: VertexOutput) -> @location(0) vec4f {\n${fBody}  return ${fReturnExpr};\n}`
  );

  return sections.join('\n\n');
}
