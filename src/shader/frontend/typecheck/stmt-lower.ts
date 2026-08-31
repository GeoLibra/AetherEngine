import type { FluxStatementNode, FluxStructNode } from '../../types';
import type {
  ShaderExpressionIR,
  ShaderFunctionIR,
  ShaderParameterIR,
  ShaderStatementIR,
  ShaderSwitchCaseIR,
  ShaderSymbolId,
  ShaderTypeId
} from '../../ir';
import type { ShaderDiagnostic, SourceSpan } from '../../types';
import { ExprLowerContext, lowerExpression } from './expr-lower';
import {
  ERROR_TYPE,
  FunctionInfo,
  SymbolInfo,
  attributeValueFromList,
  compatible,
  relatedDiagnostic,
  typeDiagnostic
} from './type-context';

export class FunctionAnalyzer implements ExprLowerContext {
  private readonly scopes: Array<Map<string, SymbolInfo>> = [new Map()];
  private loopDepth = 0;

  constructor(
    private readonly info: FunctionInfo,
    public readonly structs: ReadonlyMap<string, FluxStructNode>,
    private readonly globals: ReadonlyMap<string, SymbolInfo>,
    public readonly functions: ReadonlyMap<string, FunctionInfo>,
    public readonly resolveType: (name: string, span: SourceSpan) => ShaderTypeId,
    public readonly diagnostics: ShaderDiagnostic[],
    public nextSymbol: number
  ) {}

  lower(): ShaderFunctionIR {
    const parameters: ShaderParameterIR[] = this.info.declaration.parameters.map(
      (parameter, index) => {
        const symbol = this.declare(
          parameter.name,
          this.info.parameters[index]!,
          false,
          parameter.span
        );
        const location = attributeValueFromList(parameter.attributes, 'location');
        return Object.freeze({
          id: symbol.id,
          name: parameter.name,
          type: symbol.type,
          ...(location === undefined ? {} : { location }),
          span: parameter.span
        });
      }
    );
    const body = this.lowerStatements(this.info.declaration.body, false);
    return Object.freeze({
      id: this.info.id,
      name: this.info.declaration.name,
      parameters: Object.freeze(parameters),
      ...(this.info.returnType ? { returnType: this.info.returnType } : {}),
      body,
      span: this.info.declaration.span
    });
  }

  private lowerStatements(
    statements: readonly FluxStatementNode[],
    nested = true
  ): readonly ShaderStatementIR[] {
    if (nested) this.scopes.push(new Map());
    const lowered = statements.map((statement) => this.lowerStatement(statement));
    if (nested) this.scopes.pop();
    return Object.freeze(lowered);
  }

  private lowerStatement(statement: FluxStatementNode): ShaderStatementIR {
    switch (statement.kind) {
      case 'declare': {
        const value = statement.value ? lowerExpression(statement.value, this) : undefined;
        const type = statement.type
          ? this.resolveType(statement.type.name, statement.type.span)
          : (value?.type ?? ERROR_TYPE);
        if (value && !compatible(type, value.type))
          this.diagnostics.push(
            typeDiagnostic(
              'FLUX_ASSIGNMENT_TYPE',
              `Cannot initialize "${statement.name}" with ${value.type}; expected ${type}.`,
              statement.span
            )
          );
        const symbol = this.declare(statement.name, type, statement.mutable, statement.span);
        return Object.freeze({
          kind: 'declare',
          id: symbol.id,
          mutable: statement.mutable,
          name: statement.name,
          type,
          ...(value ? { value } : {}),
          span: statement.span
        });
      }
      case 'assign': {
        const target = lowerExpression(statement.target, this);
        const value = lowerExpression(statement.value, this);
        if (!compatible(target.type, value.type))
          this.diagnostics.push(
            typeDiagnostic(
              'FLUX_ASSIGNMENT_TYPE',
              `Cannot assign ${value.type} to ${target.type}.`,
              statement.span
            )
          );
        if (target.kind === 'symbol' && !this.findSymbolById(target.symbol)?.mutable)
          this.diagnostics.push(
            typeDiagnostic(
              'FLUX_IMMUTABLE_ASSIGNMENT',
              `Cannot assign to immutable symbol "${target.name}".`,
              statement.span
            )
          );
        return Object.freeze({ kind: 'assign', target, value, span: statement.span });
      }
      case 'if': {
        const condition = lowerExpression(statement.condition, this);
        this.requireBoolean(condition, statement.condition.span);
        const then = this.lowerStatements(statement.then);
        const otherwise = statement.otherwise
          ? this.lowerStatements(statement.otherwise)
          : undefined;
        return Object.freeze({
          kind: 'if',
          condition,
          then,
          ...(otherwise ? { otherwise } : {}),
          span: statement.span
        });
      }
      case 'switch': {
        const selector = lowerExpression(statement.selector, this);
        const cases: ShaderSwitchCaseIR[] = statement.cases.map((case_) => {
          const selectors = case_.selectors.map((value) => lowerExpression(value, this));
          for (const value of selectors)
            if (!compatible(selector.type, value.type))
              this.diagnostics.push(
                typeDiagnostic(
                  'FLUX_SWITCH_TYPE',
                  `Switch selector ${selector.type} does not match case ${value.type}.`,
                  value.span
                )
              );
          return Object.freeze({
            selectors: Object.freeze(selectors),
            default: case_.default,
            body: this.lowerStatements(case_.body),
            span: case_.span
          });
        });
        return Object.freeze({
          kind: 'switch',
          selector,
          cases: Object.freeze(cases),
          span: statement.span
        });
      }
      case 'loop': {
        this.loopDepth++;
        const body = this.lowerStatements(statement.body);
        const continuing = this.lowerStatements(statement.continuing);
        this.loopDepth--;
        return Object.freeze({ kind: 'loop', body, continuing, span: statement.span });
      }
      case 'while': {
        const condition = lowerExpression(statement.condition, this);
        this.requireBoolean(condition, statement.condition.span);
        this.loopDepth++;
        const body = this.lowerStatements(statement.body);
        this.loopDepth--;
        return Object.freeze({ kind: 'while', condition, body, span: statement.span });
      }
      case 'break':
      case 'continue':
        if (this.loopDepth === 0)
          this.diagnostics.push(
            typeDiagnostic(
              'FLUX_INVALID_CONTROL_FLOW',
              `${statement.kind} is only valid inside a loop.`,
              statement.span
            )
          );
        return Object.freeze({ kind: statement.kind, span: statement.span });
      case 'discard':
        return Object.freeze({ kind: 'discard', span: statement.span });
      case 'return': {
        const value = statement.value ? lowerExpression(statement.value, this) : undefined;
        if (
          this.info.returnType ? !value || !compatible(this.info.returnType, value.type) : !!value
        )
          this.diagnostics.push(
            typeDiagnostic(
              'FLUX_RETURN_TYPE',
              `Return value does not match ${this.info.returnType ?? 'void'}.`,
              statement.span
            )
          );
        return Object.freeze({ kind: 'return', ...(value ? { value } : {}), span: statement.span });
      }
      case 'expression':
        return Object.freeze({
          kind: 'expression',
          expression: lowerExpression(statement.expression, this),
          span: statement.span
        });
    }
  }

  private declare(
    name: string,
    type: ShaderTypeId,
    mutable: boolean,
    span: SourceSpan
  ): SymbolInfo {
    const scope = this.scopes.at(-1)!;
    const existing = scope.get(name);
    const symbol = { id: this.nextSymbol++ as ShaderSymbolId, name, type, mutable, span };
    if (existing)
      this.diagnostics.push(
        relatedDiagnostic(
          'FLUX_DUPLICATE_SYMBOL',
          `Symbol "${name}" is already declared in this scope.`,
          span,
          existing.span
        )
      );
    else scope.set(name, symbol);
    return symbol;
  }

  lookup(name: string): SymbolInfo | undefined {
    for (let index = this.scopes.length - 1; index >= 0; index--) {
      const symbol = this.scopes[index]!.get(name);
      if (symbol) return symbol;
    }
    return this.globals.get(name);
  }

  private findSymbolById(id: ShaderSymbolId): SymbolInfo | undefined {
    for (const scope of this.scopes)
      for (const symbol of scope.values()) if (symbol.id === id) return symbol;
    for (const symbol of this.globals.values()) if (symbol.id === id) return symbol;
    return undefined;
  }

  private requireBoolean(expression: ShaderExpressionIR, span: SourceSpan): void {
    if (expression.type !== 'bool' && expression.type !== ERROR_TYPE)
      this.diagnostics.push(
        typeDiagnostic(
          'FLUX_CONDITION_TYPE',
          `Control-flow condition must be bool, received ${expression.type}.`,
          span
        )
      );
  }
}
