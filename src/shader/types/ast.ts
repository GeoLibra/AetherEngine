import type { SourceSpan } from './diagnostics';

export interface FluxAttribute {
  readonly name: string;
  readonly value?: number;
  readonly span: SourceSpan;
}

export interface FluxTypeNode {
  readonly name: string;
  readonly span: SourceSpan;
}

export interface FluxParameterNode {
  readonly name: string;
  readonly type: FluxTypeNode;
  readonly attributes: readonly FluxAttribute[];
  readonly span: SourceSpan;
}

export interface FluxStructNode {
  readonly kind: 'struct';
  readonly name: string;
  readonly fields: readonly Readonly<{ name: string; type: FluxTypeNode; span: SourceSpan }>[];
  readonly span: SourceSpan;
}

export interface FluxGlobalNode {
  readonly kind: 'global';
  readonly name: string;
  readonly type: FluxTypeNode;
  readonly addressSpace: string;
  readonly access: string;
  readonly attributes: readonly FluxAttribute[];
  readonly span: SourceSpan;
}

export interface FluxVariantNode {
  readonly kind: 'variant';
  readonly name: string;
  readonly variantKind: 'boolean' | 'enum';
  readonly values: readonly string[];
  readonly fallback: boolean | string | number;
  readonly span: SourceSpan;
}

export interface FluxFunctionNode {
  readonly kind: 'function';
  readonly name: string;
  readonly parameters: readonly FluxParameterNode[];
  readonly returnType?: FluxTypeNode;
  readonly returnAttributes: readonly FluxAttribute[];
  readonly body: readonly FluxStatementNode[];
  readonly stage?: 'vertex' | 'fragment' | 'compute';
  readonly span: SourceSpan;
}

export type FluxDeclarationNode =
  FluxStructNode | FluxGlobalNode | FluxVariantNode | FluxFunctionNode;

export interface FluxModuleNode {
  readonly uri: string;
  readonly declarations: readonly FluxDeclarationNode[];
}

interface ExpressionBase {
  readonly span: SourceSpan;
}

export type FluxExpressionNode =
  | (ExpressionBase & Readonly<{ kind: 'literal'; value: boolean | number; literalType: string }>)
  | (ExpressionBase & Readonly<{ kind: 'name'; name: string }>)
  | (ExpressionBase & Readonly<{ kind: 'unary'; operator: string; operand: FluxExpressionNode }>)
  | (ExpressionBase &
      Readonly<{
        kind: 'binary';
        operator: string;
        left: FluxExpressionNode;
        right: FluxExpressionNode;
      }>)
  | (ExpressionBase &
      Readonly<{
        kind: 'call';
        callee: string;
        typeArguments: readonly FluxTypeNode[];
        arguments: readonly FluxExpressionNode[];
      }>)
  | (ExpressionBase & Readonly<{ kind: 'field'; base: FluxExpressionNode; field: string }>)
  | (ExpressionBase &
      Readonly<{ kind: 'index'; base: FluxExpressionNode; index: FluxExpressionNode }>);

interface StatementBase {
  readonly span: SourceSpan;
}

export type FluxStatementNode =
  | (StatementBase &
      Readonly<{
        kind: 'declare';
        mutable: boolean;
        name: string;
        type?: FluxTypeNode;
        value?: FluxExpressionNode;
      }>)
  | (StatementBase &
      Readonly<{ kind: 'assign'; target: FluxExpressionNode; value: FluxExpressionNode }>)
  | (StatementBase &
      Readonly<{
        kind: 'if';
        condition: FluxExpressionNode;
        then: readonly FluxStatementNode[];
        otherwise?: readonly FluxStatementNode[];
      }>)
  | (StatementBase &
      Readonly<{
        kind: 'switch';
        selector: FluxExpressionNode;
        cases: readonly FluxSwitchCaseNode[];
      }>)
  | (StatementBase &
      Readonly<{
        kind: 'loop';
        body: readonly FluxStatementNode[];
        continuing: readonly FluxStatementNode[];
      }>)
  | (StatementBase &
      Readonly<{
        kind: 'while';
        condition: FluxExpressionNode;
        body: readonly FluxStatementNode[];
      }>)
  | (StatementBase & Readonly<{ kind: 'break' | 'continue' | 'discard' }>)
  | (StatementBase & Readonly<{ kind: 'return'; value?: FluxExpressionNode }>)
  | (StatementBase & Readonly<{ kind: 'expression'; expression: FluxExpressionNode }>);

export interface FluxSwitchCaseNode {
  readonly selectors: readonly FluxExpressionNode[];
  readonly default: boolean;
  readonly body: readonly FluxStatementNode[];
  readonly span: SourceSpan;
}
