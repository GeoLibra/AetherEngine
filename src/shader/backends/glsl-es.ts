import type {
  ShaderEntryPointIR,
  ShaderExpressionIR,
  ShaderFunctionIR,
  ShaderModuleIR,
  ShaderStatementIR
} from '../types';
import type { GlslCombinedSamplerBinding } from './glsl-binding-fusion';

export const GLSL_ES_EMITTER_VERSION = 1;

export function emitGlslEsModule(
  ir: ShaderModuleIR,
  entryName: string,
  combinedSamplers: readonly GlslCombinedSamplerBinding[] = []
): string {
  const entry = ir.entryPoints.find((candidate) => candidate.name === entryName);
  if (entry === undefined) throw new Error(`Shader entry point "${entryName}" was not found.`);
  if (entry.stage === 'compute') throw new Error('WebGL2 does not support compute shaders.');
  const stage: 'vertex' | 'fragment' = entry.stage;
  const context: EmitContext = { ir, entry, combinedSamplers };
  return [
    'precision highp float;',
    'precision highp int;',
    ...ir.types.map(emitStruct),
    ...emitGlobals(context),
    ...combinedSamplers
      .filter((binding) => binding.stages.includes(stage))
      .map((binding) => `uniform ${binding.samplerType} ${binding.name};`),
    ...ir.functions.map((function_) => emitFunction(function_, context)),
    emitEntryPoint(entry, context)
  ]
    .filter(Boolean)
    .join('\n\n');
}

interface EmitContext {
  readonly ir: ShaderModuleIR;
  readonly entry: ShaderEntryPointIR;
  readonly combinedSamplers: readonly GlslCombinedSamplerBinding[];
}

function emitStruct(type: ShaderModuleIR['types'][number]): string {
  return `struct ${type.name} {\n${type.fields.map((field) => `  ${glslType(field.type)} ${field.name};`).join('\n')}\n};`;
}

function emitGlobals(context: EmitContext): string[] {
  const result: string[] = [];
  for (const global of context.ir.globals) {
    if (global.addressSpace === 'handle') continue;
    if (global.addressSpace === 'uniform') {
      result.push(
        `layout(std140) uniform Aether_${global.group}_${global.binding} {\n  ${glslType(global.type)} ${global.name};\n};`
      );
    } else if (global.location !== undefined) {
      result.push(
        `layout(location = ${global.location}) ${global.addressSpace === 'in' ? 'in' : 'out'} ${glslType(global.type)} ${global.name};`
      );
    }
  }
  for (const parameter of context.entry.parameters) {
    if (parameter.location !== undefined) {
      result.push(
        `layout(location = ${parameter.location}) in ${glslType(parameter.type)} ${parameter.name};`
      );
      continue;
    }
    const parameterStruct = findStruct(context.ir, parameter.type);
    if (context.entry.stage === 'fragment' && parameterStruct !== undefined) {
      for (const field of parameterStruct.fields) {
        if (field.location !== undefined) {
          result.push(`in ${glslType(field.type)} aether_varying_${field.name};`);
        }
      }
    }
  }
  if (context.entry.stage === 'vertex' && context.entry.returnType !== undefined) {
    const outputStruct = findStruct(context.ir, context.entry.returnType);
    for (const field of outputStruct?.fields ?? []) {
      if (field.location !== undefined) {
        result.push(`out ${glslType(field.type)} aether_varying_${field.name};`);
      }
    }
  }
  if (context.entry.stage === 'fragment' && context.entry.returnType !== undefined) {
    result.push(
      `layout(location = ${context.entry.returnLocation ?? 0}) out ${glslType(context.entry.returnType)} aether_fragment_output;`
    );
  }
  return result;
}

function emitFunction(function_: ShaderFunctionIR, context: EmitContext): string {
  const result = function_.returnType === undefined ? 'void' : glslType(function_.returnType);
  const parameters = function_.parameters
    .map((parameter) => `${glslType(parameter.type)} ${parameter.name}`)
    .join(', ');
  return `${result} ${function_.name}(${parameters}) ${emitBlock(function_.body, context)}`;
}

function emitEntryPoint(entry: ShaderEntryPointIR, context: EmitContext): string {
  const prelude = entry.parameters.flatMap((parameter) => {
    if (parameter.location !== undefined) return [];
    const struct = findStruct(context.ir, parameter.type);
    if (entry.stage !== 'fragment' || struct === undefined) return [];
    const arguments_ = struct.fields.map((field) => {
      if (field.location === undefined) {
        throw new Error(
          `GLSL ES fragment interface field "${struct.name}.${field.name}" requires a location.`
        );
      }
      return `aether_varying_${field.name}`;
    });
    return [`${struct.name} ${parameter.name} = ${struct.name}(${arguments_.join(', ')});`];
  });
  return `void main() ${emitBlock(entry.body, context, entry, '', prelude)}`;
}

function emitBlock(
  statements: readonly ShaderStatementIR[],
  context: EmitContext,
  entry?: ShaderEntryPointIR,
  indentation = '',
  prelude: readonly string[] = []
): string {
  if (statements.length === 0 && prelude.length === 0) return '{}';
  const child = `${indentation}  `;
  return `{\n${[
    ...prelude.map((statement) => `${child}${statement}`),
    ...statements.map((statement) => `${child}${emitStatement(statement, context, entry, child)}`)
  ].join('\n')}\n${indentation}}`;
}

function emitStatement(
  statement: ShaderStatementIR,
  context: EmitContext,
  entry: ShaderEntryPointIR | undefined,
  indentation: string
): string {
  switch (statement.kind) {
    case 'declare':
      return `${glslType(statement.type)} ${statement.name}${statement.value === undefined ? '' : ` = ${emitExpression(statement.value, context)}`};`;
    case 'assign':
      return `${emitExpression(statement.target, context)} = ${emitExpression(statement.value, context)};`;
    case 'if':
      return `if (${emitExpression(statement.condition, context)}) ${emitBlock(statement.then, context, entry, indentation)}${statement.otherwise === undefined ? '' : ` else ${emitBlock(statement.otherwise, context, entry, indentation)}`}`;
    case 'while':
      return `while (${emitExpression(statement.condition, context)}) ${emitBlock(statement.body, context, entry, indentation)}`;
    case 'break':
    case 'continue':
    case 'discard':
      return `${statement.kind};`;
    case 'return': {
      if (entry === undefined || statement.value === undefined)
        return `return${statement.value === undefined ? '' : ` ${emitExpression(statement.value, context)}`};`;
      const outputStruct =
        entry.stage === 'vertex' && entry.returnType !== undefined
          ? findStruct(context.ir, entry.returnType)
          : undefined;
      if (outputStruct !== undefined) {
        if (
          statement.value.kind !== 'construct' ||
          statement.value.arguments.length !== outputStruct.fields.length
        ) {
          throw new Error(
            `GLSL ES vertex entry "${entry.name}" must construct its declared interface result.`
          );
        }
        const constructed = statement.value;
        const assignments = outputStruct.fields.map((field, index) => {
          const value = constructed.arguments[index];
          if (value === undefined) throw new Error('Shader interface result is incomplete.');
          const target =
            field.builtin === 'position'
              ? 'gl_Position'
              : field.location !== undefined
                ? `aether_varying_${field.name}`
                : undefined;
          if (target === undefined) {
            throw new Error(
              `GLSL ES vertex interface field "${outputStruct.name}.${field.name}" requires a builtin or location.`
            );
          }
          return `${target} = ${emitExpression(value, context)};`;
        });
        return `${assignments.join(`\n${indentation}`)}\n${indentation}return;`;
      }
      const output = entry.stage === 'vertex' ? 'gl_Position' : 'aether_fragment_output';
      return `${output} = ${emitExpression(statement.value, context)};\n${indentation}return;`;
    }
    case 'expression':
      return `${emitExpression(statement.expression, context)};`;
    case 'loop':
      if (statement.continuing.length !== 0)
        throw new Error('GLSL ES emitter does not yet support loop continuing blocks.');
      return `for (;;) ${emitBlock(statement.body, context, entry, indentation)}`;
    case 'switch':
      throw new Error('GLSL ES emitter does not yet support switch statements.');
  }
}

function findStruct(ir: ShaderModuleIR, type: string) {
  return ir.types.find((candidate) => candidate.name === type);
}

function emitExpression(expression: ShaderExpressionIR, context: EmitContext): string {
  switch (expression.kind) {
    case 'literal':
      if (typeof expression.value === 'boolean') return String(expression.value);
      if (expression.type === 'u32') return `${expression.value}u`;
      return expression.type === 'f32' && Number.isInteger(expression.value)
        ? `${expression.value}.0`
        : String(expression.value);
    case 'symbol':
      return expression.name;
    case 'unary':
      return `${expression.operator}${emitExpression(expression.operand, context)}`;
    case 'binary':
      return `(${emitExpression(expression.left, context)} ${expression.operator} ${emitExpression(expression.right, context)})`;
    case 'construct':
      return `${glslType(expression.type)}(${expression.arguments.map((argument) => emitExpression(argument, context)).join(', ')})`;
    case 'call':
      return `${expression.name}(${expression.arguments.map((argument) => emitExpression(argument, context)).join(', ')})`;
    case 'intrinsic':
      return emitIntrinsic(expression, context);
    case 'field':
      return `${emitExpression(expression.base, context)}.${expression.field}`;
    case 'index':
      return `${emitExpression(expression.base, context)}[${emitExpression(expression.index, context)}]`;
  }
}

function emitIntrinsic(
  expression: Extract<ShaderExpressionIR, { kind: 'intrinsic' }>,
  context: EmitContext
): string {
  if (expression.intrinsic === 'textureSample' && expression.arguments.length >= 3) {
    const [texture, sampler, coordinates] = expression.arguments;
    if (texture?.kind !== 'symbol' || sampler?.kind !== 'symbol' || coordinates === undefined)
      throw new Error('textureSample requires direct texture and sampler symbols.');
    const textureGlobal = context.ir.globals.find((global) => global.id === texture.symbol);
    const samplerGlobal = context.ir.globals.find((global) => global.id === sampler.symbol);
    const fused = context.combinedSamplers.find(
      (binding) =>
        binding.textureGroup === textureGlobal?.group &&
        binding.textureBinding === textureGlobal.binding &&
        binding.samplerGroup === samplerGlobal?.group &&
        binding.samplerBinding === samplerGlobal.binding
    );
    if (fused === undefined) throw new Error('textureSample has no fused GLSL sampler binding.');
    return `texture(${fused.name}, ${emitExpression(coordinates, context)})`;
  }
  return `${expression.intrinsic}(${expression.arguments.map((argument) => emitExpression(argument, context)).join(', ')})`;
}

function glslType(type: string): string {
  const direct: Record<string, string> = {
    f32: 'float',
    i32: 'int',
    u32: 'uint',
    bool: 'bool',
    bool32: 'bool',
    'vec2<f32>': 'vec2',
    'vec3<f32>': 'vec3',
    'vec4<f32>': 'vec4',
    'vec2<i32>': 'ivec2',
    'vec3<i32>': 'ivec3',
    'vec4<i32>': 'ivec4',
    'vec2<u32>': 'uvec2',
    'vec3<u32>': 'uvec3',
    'vec4<u32>': 'uvec4',
    'mat2x2<f32>': 'mat2',
    'mat3x3<f32>': 'mat3',
    'mat4x4<f32>': 'mat4'
  };
  return direct[type] ?? type;
}
