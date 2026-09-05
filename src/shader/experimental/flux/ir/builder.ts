import type {
  ShaderExpressionIR,
  ShaderGlobalIR,
  ShaderStructFieldIR,
  ShaderStructTypeIR,
  ShaderSymbolId,
  ShaderTypeId,
  SourceSpan
} from '../../../types';

const DEFAULT_SPAN: SourceSpan = Object.freeze({
  uri: 'shader://ir-builder',
  line: 1,
  column: 1,
  length: 1
});

/**
 * Casts a string representation to a typed ShaderTypeId.
 */
export function shaderType(type: string): ShaderTypeId {
  return type as ShaderTypeId;
}

/**
 * Creates a symbol reference expression IR node.
 */
export function symbolExpr(
  id: number | ShaderSymbolId,
  name: string,
  type: string,
  span: SourceSpan = DEFAULT_SPAN
): ShaderExpressionIR {
  return Object.freeze({
    kind: 'symbol',
    symbol: id as ShaderSymbolId,
    name,
    type: shaderType(type),
    span
  });
}

/**
 * Creates a literal scalar/boolean expression IR node.
 */
export function literalExpr(
  value: number | boolean,
  type = typeof value === 'boolean' ? 'bool' : 'f32',
  span: SourceSpan = DEFAULT_SPAN
): ShaderExpressionIR {
  return Object.freeze({
    kind: 'literal',
    value,
    type: shaderType(type),
    span
  });
}

/**
 * Creates a struct or vector field access expression IR node.
 */
export function fieldExpr(
  base: ShaderExpressionIR,
  name: string,
  type: string,
  span: SourceSpan = DEFAULT_SPAN
): ShaderExpressionIR {
  return Object.freeze({
    kind: 'field',
    base,
    field: name,
    type: shaderType(type),
    span
  });
}

/**
 * Creates a type constructor expression IR node.
 */
export function constructExpr(
  type: string,
  arguments_: readonly ShaderExpressionIR[],
  span: SourceSpan = DEFAULT_SPAN
): ShaderExpressionIR {
  return Object.freeze({
    kind: 'construct',
    type: shaderType(type),
    arguments: Object.freeze([...arguments_]),
    span
  });
}

/**
 * Creates a binary operator expression IR node.
 */
export function binaryExpr(
  operator: string,
  left: ShaderExpressionIR,
  right: ShaderExpressionIR,
  type: string,
  span: SourceSpan = DEFAULT_SPAN
): ShaderExpressionIR {
  return Object.freeze({
    kind: 'binary',
    operator,
    left,
    right,
    type: shaderType(type),
    span
  });
}

/**
 * Creates a unary operator expression IR node.
 */
export function unaryExpr(
  operator: string,
  operand: ShaderExpressionIR,
  type: string,
  span: SourceSpan = DEFAULT_SPAN
): ShaderExpressionIR {
  return Object.freeze({
    kind: 'unary',
    operator,
    operand,
    type: shaderType(type),
    span
  });
}

/**
 * Creates an intrinsic function call expression IR node (e.g. normalize, dot, max).
 */
export function intrinsicExpr(
  name: string,
  arguments_: readonly ShaderExpressionIR[],
  type: string,
  span: SourceSpan = DEFAULT_SPAN
): ShaderExpressionIR {
  return Object.freeze({
    kind: 'intrinsic',
    intrinsic: name,
    arguments: Object.freeze([...arguments_]),
    type: shaderType(type),
    span
  });
}

function isTupleField(
  field: readonly [string, string] | ShaderStructFieldIR
): field is readonly [string, string] {
  return Array.isArray(field);
}

/**
 * Creates a structured struct type definition IR.
 */
export function createStructTypeIR(
  name: string,
  fields: readonly (readonly [string, string])[] | readonly ShaderStructFieldIR[]
): ShaderStructTypeIR {
  const normalizedFields: readonly ShaderStructFieldIR[] = (
    fields as readonly (readonly [string, string] | ShaderStructFieldIR)[]
  ).map((field): ShaderStructFieldIR => {
    if (isTupleField(field)) {
      const [fieldName, fieldType] = field;
      return Object.freeze({ name: fieldName, type: fieldType });
    }
    return Object.freeze({ ...field });
  });

  return Object.freeze({
    kind: 'struct',
    name,
    fields: Object.freeze(normalizedFields)
  });
}

/**
 * Creates a global uniform buffer declaration IR.
 */
export function createUniformGlobalIR(
  id: number | ShaderSymbolId,
  name: string,
  type: string,
  group: number,
  binding = 0,
  span: SourceSpan = DEFAULT_SPAN
): ShaderGlobalIR {
  return Object.freeze({
    id: id as ShaderSymbolId,
    name,
    type,
    addressSpace: 'uniform',
    access: 'read',
    group,
    binding,
    span
  });
}
