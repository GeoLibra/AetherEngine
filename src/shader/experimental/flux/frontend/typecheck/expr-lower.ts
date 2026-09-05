import type { FluxExpressionNode, FluxStructNode } from '../../../../types';
import type { ShaderExpressionIR, ShaderSymbolId, ShaderTypeId } from '../../ir';
import type { ShaderDiagnostic, SourceSpan } from '../../../../types';
import {
  ERROR_TYPE,
  FunctionInfo,
  SymbolInfo,
  compatible,
  inferIntrinsic,
  isConstructorName,
  typeDiagnostic
} from './type-context';

export interface ExprLowerContext {
  readonly structs: ReadonlyMap<string, FluxStructNode>;
  readonly functions: ReadonlyMap<string, FunctionInfo>;
  readonly diagnostics: ShaderDiagnostic[];
  lookup(name: string): SymbolInfo | undefined;
  resolveType(name: string, span: SourceSpan): ShaderTypeId;
}

export function lowerExpression(
  expression: FluxExpressionNode,
  ctx: ExprLowerContext
): ShaderExpressionIR {
  switch (expression.kind) {
    case 'literal':
      return Object.freeze({
        kind: 'literal',
        value: expression.value,
        type: expression.literalType as ShaderTypeId,
        span: expression.span
      });
    case 'name': {
      const symbol = ctx.lookup(expression.name);
      if (!symbol) {
        ctx.diagnostics.push(
          typeDiagnostic(
            'FLUX_UNKNOWN_SYMBOL',
            `Unknown symbol "${expression.name}".`,
            expression.span
          )
        );
        return Object.freeze({
          kind: 'symbol',
          symbol: 0 as ShaderSymbolId,
          name: expression.name,
          type: ERROR_TYPE,
          span: expression.span
        });
      }
      return Object.freeze({
        kind: 'symbol',
        symbol: symbol.id,
        name: expression.name,
        type: symbol.type,
        span: expression.span
      });
    }
    case 'unary': {
      const operand = lowerExpression(expression.operand, ctx);
      if (expression.operator === '!' && operand.type !== 'bool')
        ctx.diagnostics.push(
          typeDiagnostic('FLUX_OPERAND_TYPE', 'Logical negation requires bool.', expression.span)
        );
      return Object.freeze({
        kind: 'unary',
        operator: expression.operator,
        operand,
        type: expression.operator === '!' ? ('bool' as ShaderTypeId) : operand.type,
        span: expression.span
      });
    }
    case 'binary':
      return lowerBinary(expression, ctx);
    case 'call':
      return lowerCall(expression, ctx);
    case 'field': {
      const base = lowerExpression(expression.base, ctx);
      let type = ERROR_TYPE;
      const struct = ctx.structs.get(base.type);
      const field = struct?.fields.find((candidate) => candidate.name === expression.field);
      if (field) type = ctx.resolveType(field.type.name, field.type.span);
      else {
        const vector = /^vec([234])<(.+)>$/.exec(base.type);
        if (vector && /^[xyzwrgba]{1,4}$/.test(expression.field))
          type =
            expression.field.length === 1
              ? (vector[2] as ShaderTypeId)
              : (`vec${expression.field.length}<${vector[2]}>` as ShaderTypeId);
        else
          ctx.diagnostics.push(
            typeDiagnostic(
              'FLUX_UNKNOWN_FIELD',
              `Type ${base.type} has no field "${expression.field}".`,
              expression.span
            )
          );
      }
      return Object.freeze({
        kind: 'field',
        base,
        field: expression.field,
        type,
        span: expression.span
      });
    }
    case 'index': {
      const base = lowerExpression(expression.base, ctx);
      const index = lowerExpression(expression.index, ctx);
      let type = ERROR_TYPE;
      const array = /^array<(.+),(\d+)>$/.exec(base.type);
      const vector = /^vec[234]<(.+)>$/.exec(base.type);
      const matrix = /^mat[234]x([234])<(.+)>$/.exec(base.type);
      if (array) type = array[1] as ShaderTypeId;
      else if (vector) type = vector[1] as ShaderTypeId;
      else if (matrix) type = `vec${matrix[1]}<${matrix[2]}>` as ShaderTypeId;
      else
        ctx.diagnostics.push(
          typeDiagnostic(
            'FLUX_NOT_INDEXABLE',
            `Type ${base.type} is not indexable.`,
            expression.span
          )
        );
      if (
        type !== ERROR_TYPE &&
        index.type !== 'i32' &&
        index.type !== 'u32' &&
        index.type !== ERROR_TYPE
      )
        ctx.diagnostics.push(
          typeDiagnostic(
            'FLUX_INDEX_TYPE',
            'Index expressions require i32 or u32.',
            expression.index.span
          )
        );
      return Object.freeze({ kind: 'index', base, index, type, span: expression.span });
    }
  }
}

function lowerBinary(
  expression: Extract<FluxExpressionNode, { kind: 'binary' }>,
  ctx: ExprLowerContext
): ShaderExpressionIR {
  const left = lowerExpression(expression.left, ctx);
  const right = lowerExpression(expression.right, ctx);
  const comparison = ['==', '!=', '<', '<=', '>', '>='].includes(expression.operator);
  const logical = expression.operator === '&&' || expression.operator === '||';
  const arithmeticType = inferArithmeticType(expression.operator, left.type, right.type);
  if (logical && (left.type !== 'bool' || right.type !== 'bool'))
    ctx.diagnostics.push(
      typeDiagnostic(
        'FLUX_OPERAND_TYPE',
        `Operator ${expression.operator} requires bool operands.`,
        expression.span
      )
    );
  else if (!logical && arithmeticType === undefined)
    ctx.diagnostics.push(
      typeDiagnostic(
        'FLUX_OPERAND_TYPE',
        `Operator ${expression.operator} cannot combine ${left.type} and ${right.type}.`,
        expression.span
      )
    );
  return Object.freeze({
    kind: 'binary',
    operator: expression.operator,
    left,
    right,
    type: comparison || logical ? ('bool' as ShaderTypeId) : (arithmeticType ?? ERROR_TYPE),
    span: expression.span
  });
}

function inferArithmeticType(
  operator: string,
  left: ShaderTypeId,
  right: ShaderTypeId
): ShaderTypeId | undefined {
  if (compatible(left, right)) return left;
  if (!['+', '-', '*', '/'].includes(operator)) return undefined;

  const leftVector = /^vec([234])<(f32|i32|u32)>$/.exec(left);
  const rightVector = /^vec([234])<(f32|i32|u32)>$/.exec(right);
  if (leftVector && right === leftVector[2]) return left;
  if (rightVector && left === rightVector[2]) return right;

  if (operator !== '*') return undefined;
  const leftMatrix = /^mat([234])x([234])<f32>$/.exec(left);
  const rightMatrix = /^mat([234])x([234])<f32>$/.exec(right);
  if (leftMatrix && right === 'f32') return left;
  if (rightMatrix && left === 'f32') return right;
  if (leftMatrix && rightVector?.[2] === 'f32' && leftMatrix[1] === rightVector[1])
    return `vec${leftMatrix[2]}<f32>` as ShaderTypeId;
  if (leftVector?.[2] === 'f32' && rightMatrix && leftVector[1] === rightMatrix[2])
    return `vec${rightMatrix[1]}<f32>` as ShaderTypeId;
  if (leftMatrix && rightMatrix && leftMatrix[1] === rightMatrix[2])
    return `mat${rightMatrix[1]}x${leftMatrix[2]}<f32>` as ShaderTypeId;
  return undefined;
}

function lowerCall(
  expression: Extract<FluxExpressionNode, { kind: 'call' }>,
  ctx: ExprLowerContext
): ShaderExpressionIR {
  const arguments_ = Object.freeze(
    expression.arguments.map((argument) => lowerExpression(argument, ctx))
  );
  const typeName =
    expression.typeArguments.length > 0
      ? `${expression.callee}<${expression.typeArguments.map((type) => type.name).join(',')}>`
      : expression.callee;
  if (isConstructorName(expression.callee, expression.typeArguments.length > 0, ctx.structs)) {
    const type = ctx.resolveType(typeName, expression.span);
    return Object.freeze({
      kind: 'construct',
      arguments: arguments_,
      type,
      span: expression.span
    });
  }
  const function_ = ctx.functions.get(expression.callee);
  if (function_) {
    if (
      function_.parameters.length !== arguments_.length ||
      function_.parameters.some(
        (type, index) => !compatible(type, arguments_[index]?.type ?? ERROR_TYPE)
      )
    )
      ctx.diagnostics.push(
        typeDiagnostic(
          'FLUX_CALL_ARGUMENT_TYPE',
          `Arguments do not match function "${expression.callee}".`,
          expression.span
        )
      );
    return Object.freeze({
      kind: 'call',
      function: function_.id,
      name: expression.callee,
      arguments: arguments_,
      type: function_.returnType ?? ERROR_TYPE,
      span: expression.span
    });
  }
  const intrinsicType = inferIntrinsic(expression.callee, arguments_);
  if (intrinsicType)
    return Object.freeze({
      kind: 'intrinsic',
      intrinsic: expression.callee,
      arguments: arguments_,
      type: intrinsicType,
      span: expression.span
    });
  ctx.diagnostics.push(
    typeDiagnostic(
      'FLUX_UNKNOWN_FUNCTION',
      `Unknown function or intrinsic "${expression.callee}".`,
      expression.span
    )
  );
  return Object.freeze({
    kind: 'intrinsic',
    intrinsic: expression.callee,
    arguments: arguments_,
    type: ERROR_TYPE,
    span: expression.span
  });
}
