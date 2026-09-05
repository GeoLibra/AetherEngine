import type {
  ShaderEntryPointIR,
  ShaderExpressionIR,
  ShaderFunctionIR,
  ShaderModuleIR,
  ShaderStatementIR
} from '../../../../types';

/**
 * Translates a complete ShaderModuleIR back into standard compliant WGSL source code.
 *
 * Emission Order:
 * 1. Struct definitions (`types`)
 * 2. Global resources and inputs/outputs (`globals`)
 * 3. Helper utility functions (`functions`)
 * 4. Shader entry points (vertex, fragment, compute)
 */
export function emitWgslModule(
  ir: ShaderModuleIR,
  entries: readonly string[] = ir.entryPoints.map((entry) => entry.name)
): string {
  const selected = ir.entryPoints.filter((entry) => entries.includes(entry.name));
  return [
    ...ir.types.map(
      (type) =>
        `struct ${type.name} {\n${type.fields
          .map((field) => {
            const attribute =
              field.builtin !== undefined
                ? `@builtin(${field.builtin}) `
                : field.location !== undefined
                  ? `@location(${field.location}) `
                  : '';
            return `  ${attribute}${field.name}: ${field.type},`;
          })
          .join('\n')}\n}`
    ),
    ...ir.globals.map(emitGlobal),
    ...ir.functions.map(emitFunction),
    ...selected.map(emitEntryPoint)
  ].join('\n\n');
}

/**
 * Generates global variable declarations with annotations such as @group, @binding, and @location.
 */
function emitGlobal(global: ShaderModuleIR['globals'][number]): string {
  const attributes = [
    global.group === undefined ? undefined : `@group(${global.group})`,
    global.binding === undefined ? undefined : `@binding(${global.binding})`,
    global.location === undefined ? undefined : `@location(${global.location})`
  ].filter((value): value is string => value !== undefined);
  const access =
    global.addressSpace === 'storage' && global.access === 'read_write' ? ', read_write' : '';
  const address = global.addressSpace === 'handle' ? '' : `<${global.addressSpace}${access}>`;
  return `${attributes.length === 0 ? '' : `${attributes.join(' ')} `}var${address} ${global.name}: ${global.type};`;
}

function emitFunction(function_: ShaderFunctionIR): string {
  return `fn ${function_.name}(${emitParameters(function_)})${emitReturn(function_)} ${emitBlock(function_.body)}`;
}

function emitEntryPoint(entry: ShaderEntryPointIR): string {
  return `@${entry.stage} fn ${entry.name}(${emitParameters(entry)})${emitReturn(entry)} ${emitBlock(entry.body)}`;
}

function emitParameters(function_: ShaderFunctionIR): string {
  return function_.parameters
    .map(
      (parameter) =>
        `${parameter.location === undefined ? '' : `@location(${parameter.location}) `}${parameter.name}: ${parameter.type}`
    )
    .join(', ');
}

function emitReturn(function_: ShaderFunctionIR | ShaderEntryPointIR): string {
  if (function_.returnType === undefined) return '';
  const location = 'returnLocation' in function_ ? function_.returnLocation : undefined;
  return ` -> ${location === undefined ? '' : `@location(${location}) `}${function_.returnType}`;
}

function emitBlock(statements: readonly ShaderStatementIR[], indentation = ''): string {
  if (statements.length === 0) return '{}';
  const child = `${indentation}  `;
  return `{\n${statements.map((statement) => `${child}${emitStatement(statement, child)}`).join('\n')}\n${indentation}}`;
}

/**
 * Translates an IR statement (declaration, assignment, conditional, loops, switches) into WGSL syntax.
 */
function emitStatement(statement: ShaderStatementIR, indentation: string): string {
  switch (statement.kind) {
    case 'declare':
      return `${statement.mutable ? 'var' : 'let'} ${statement.name}: ${statement.type}${statement.value === undefined ? '' : ` = ${emitExpression(statement.value)}`};`;
    case 'assign':
      return `${emitExpression(statement.target)} = ${emitExpression(statement.value)};`;
    case 'if':
      return `if (${emitExpression(statement.condition)}) ${emitBlock(statement.then, indentation)}${statement.otherwise === undefined ? '' : ` else ${emitBlock(statement.otherwise, indentation)}`}`;
    case 'switch':
      return `switch (${emitExpression(statement.selector)}) {\n${statement.cases
        .map((case_) => {
          const selector = case_.default
            ? 'default'
            : `case ${case_.selectors.map(emitExpression).join(', ')}`;
          return `${indentation}  ${selector}: ${emitBlock(case_.body, `${indentation}  `)}`;
        })
        .join('\n')}\n${indentation}}`;
    case 'loop':
      return `loop {\n${statement.body
        .map((item) => `${indentation}  ${emitStatement(item, `${indentation}  `)}`)
        .join(
          '\n'
        )}${statement.continuing.length === 0 ? '' : `\n${indentation}  continuing ${emitBlock(statement.continuing, `${indentation}  `)}`}\n${indentation}}`;
    case 'while':
      return `while (${emitExpression(statement.condition)}) ${emitBlock(statement.body, indentation)}`;
    case 'break':
    case 'continue':
    case 'discard':
      return `${statement.kind};`;
    case 'return':
      return `return${statement.value === undefined ? '' : ` ${emitExpression(statement.value)}`};`;
    case 'expression':
      return `${emitExpression(statement.expression)};`;
  }
}

/**
 * Translates an IR expression (literals, variables, operators, member accessors, intrinsics) to WGSL format.
 */
function emitExpression(expression: ShaderExpressionIR): string {
  switch (expression.kind) {
    case 'literal':
      if (typeof expression.value === 'boolean') return expression.value ? 'true' : 'false';
      if (expression.type === 'u32') return `${expression.value}u`;
      if (expression.type === 'f32' && Number.isInteger(expression.value))
        return `${expression.value}.0`;
      return String(expression.value);
    case 'symbol':
      return expression.name;
    case 'unary':
      return `${expression.operator}${emitExpression(expression.operand)}`;
    case 'binary':
      return `(${emitExpression(expression.left)} ${expression.operator} ${emitExpression(expression.right)})`;
    case 'construct':
      return `${expression.type}(${expression.arguments.map(emitExpression).join(', ')})`;
    case 'call':
      return `${expression.name}(${expression.arguments.map(emitExpression).join(', ')})`;
    case 'intrinsic':
      return `${expression.intrinsic}(${expression.arguments.map(emitExpression).join(', ')})`;
    case 'field':
      return `${emitExpression(expression.base)}.${expression.field}`;
    case 'index':
      return `${emitExpression(expression.base)}[${emitExpression(expression.index)}]`;
  }
}
