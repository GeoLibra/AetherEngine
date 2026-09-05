import type { SourceSpan } from '../../../types';
import type { ShaderFunctionId, ShaderSymbolId, ShaderTypeId } from './symbols';

export interface ShaderParameterIR {
  readonly id: ShaderSymbolId;
  readonly name: string;
  readonly type: ShaderTypeId;
  readonly location?: number;
  readonly span: SourceSpan;
}

interface ShaderExpressionBase {
  readonly type: ShaderTypeId;
  readonly span: SourceSpan;
}

export interface ShaderLiteralExpressionIR extends ShaderExpressionBase {
  readonly kind: 'literal';
  readonly value: boolean | number;
}
export interface ShaderSymbolExpressionIR extends ShaderExpressionBase {
  readonly kind: 'symbol';
  readonly symbol: ShaderSymbolId;
  readonly name: string;
}
export interface ShaderUnaryExpressionIR extends ShaderExpressionBase {
  readonly kind: 'unary';
  readonly operator: string;
  readonly operand: ShaderExpressionIR;
}
export interface ShaderBinaryExpressionIR extends ShaderExpressionBase {
  readonly kind: 'binary';
  readonly operator: string;
  readonly left: ShaderExpressionIR;
  readonly right: ShaderExpressionIR;
}
export interface ShaderConstructExpressionIR extends ShaderExpressionBase {
  readonly kind: 'construct';
  readonly arguments: readonly ShaderExpressionIR[];
}
export interface ShaderCallExpressionIR extends ShaderExpressionBase {
  readonly kind: 'call';
  readonly function: ShaderFunctionId;
  readonly name: string;
  readonly arguments: readonly ShaderExpressionIR[];
}
export interface ShaderIntrinsicExpressionIR extends ShaderExpressionBase {
  readonly kind: 'intrinsic';
  readonly intrinsic: string;
  readonly arguments: readonly ShaderExpressionIR[];
}
export interface ShaderFieldExpressionIR extends ShaderExpressionBase {
  readonly kind: 'field';
  readonly base: ShaderExpressionIR;
  readonly field: string;
}
export interface ShaderIndexExpressionIR extends ShaderExpressionBase {
  readonly kind: 'index';
  readonly base: ShaderExpressionIR;
  readonly index: ShaderExpressionIR;
}

export type ShaderExpressionIR =
  | ShaderLiteralExpressionIR
  | ShaderSymbolExpressionIR
  | ShaderUnaryExpressionIR
  | ShaderBinaryExpressionIR
  | ShaderConstructExpressionIR
  | ShaderCallExpressionIR
  | ShaderIntrinsicExpressionIR
  | ShaderFieldExpressionIR
  | ShaderIndexExpressionIR;

interface ShaderStatementBase {
  readonly span: SourceSpan;
}
export type ShaderStatementIR =
  | (ShaderStatementBase &
      Readonly<{
        kind: 'declare';
        id: ShaderSymbolId;
        mutable: boolean;
        name: string;
        type: ShaderTypeId;
        value?: ShaderExpressionIR;
      }>)
  | (ShaderStatementBase &
      Readonly<{ kind: 'assign'; target: ShaderExpressionIR; value: ShaderExpressionIR }>)
  | (ShaderStatementBase &
      Readonly<{
        kind: 'if';
        condition: ShaderExpressionIR;
        then: readonly ShaderStatementIR[];
        otherwise?: readonly ShaderStatementIR[];
      }>)
  | (ShaderStatementBase &
      Readonly<{
        kind: 'switch';
        selector: ShaderExpressionIR;
        cases: readonly ShaderSwitchCaseIR[];
      }>)
  | (ShaderStatementBase &
      Readonly<{
        kind: 'loop';
        body: readonly ShaderStatementIR[];
        continuing: readonly ShaderStatementIR[];
      }>)
  | (ShaderStatementBase &
      Readonly<{
        kind: 'while';
        condition: ShaderExpressionIR;
        body: readonly ShaderStatementIR[];
      }>)
  | (ShaderStatementBase & Readonly<{ kind: 'break' | 'continue' | 'discard' }>)
  | (ShaderStatementBase & Readonly<{ kind: 'return'; value?: ShaderExpressionIR }>)
  | (ShaderStatementBase & Readonly<{ kind: 'expression'; expression: ShaderExpressionIR }>);

export interface ShaderSwitchCaseIR {
  readonly selectors: readonly ShaderExpressionIR[];
  readonly default: boolean;
  readonly body: readonly ShaderStatementIR[];
  readonly span: SourceSpan;
}

export interface ShaderFunctionIR {
  readonly id: ShaderFunctionId;
  readonly name: string;
  readonly parameters: readonly ShaderParameterIR[];
  readonly returnType?: ShaderTypeId;
  readonly body: readonly ShaderStatementIR[];
  readonly span: SourceSpan;
}

export interface ShaderEntryPointIR extends ShaderFunctionIR {
  readonly stage: 'vertex' | 'fragment' | 'compute';
  readonly returnLocation?: number;
}
