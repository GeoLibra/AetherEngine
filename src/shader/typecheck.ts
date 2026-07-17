import type {
  FluxDeclarationNode,
  FluxExpressionNode,
  FluxFunctionNode,
  FluxModuleNode,
  FluxStatementNode,
  FluxStructNode
} from './frontend-ast';
import type {
  ShaderEntryPointIR,
  ShaderExpressionIR,
  ShaderFunctionId,
  ShaderFunctionIR,
  ShaderParameterIR,
  ShaderStatementIR,
  ShaderSwitchCaseIR,
  ShaderSymbolId,
  ShaderTypeId
} from './ir';
import type {
  ShaderDiagnostic,
  ShaderGlobalIR,
  ShaderModuleIR,
  ShaderStructTypeIR,
  ShaderVariantDimension,
  SourceSpan
} from './types';

interface LowerResult {
  readonly ir?: ShaderModuleIR;
  readonly diagnostics: readonly ShaderDiagnostic[];
}
interface SymbolInfo {
  readonly id: ShaderSymbolId;
  readonly name: string;
  readonly type: ShaderTypeId;
  readonly mutable: boolean;
  readonly span: SourceSpan;
}
interface FunctionInfo {
  readonly id: ShaderFunctionId;
  readonly declaration: FluxFunctionNode;
  readonly parameters: readonly ShaderTypeId[];
  readonly returnType?: ShaderTypeId;
}

const ERROR_TYPE = '<error>' as ShaderTypeId;
const BUILTIN_SCALARS = new Set(['f32', 'i32', 'u32', 'bool']);
const ADDRESS_SPACES = new Set(['uniform', 'storage', 'in', 'out', 'handle', 'private']);

export function lowerFluxModules(
  modules: readonly FluxModuleNode[],
  sourceClosureHash: string
): LowerResult {
  const declarations = modules.flatMap((module) => module.declarations);
  const diagnostics: ShaderDiagnostic[] = [];
  const structs = new Map<string, FluxStructNode>();
  const types: ShaderStructTypeIR[] = [];
  const variants: ShaderVariantDimension[] = [];

  for (const declaration of declarations) {
    if (declaration.kind === 'struct') {
      const existing = structs.get(declaration.name);
      if (existing)
        diagnostics.push(
          relatedDiagnostic(
            'FLUX_DUPLICATE_TYPE',
            `Type "${declaration.name}" is already declared.`,
            declaration.span,
            existing.span
          )
        );
      else structs.set(declaration.name, declaration);
    } else if (declaration.kind === 'variant') {
      variants.push(
        Object.freeze({
          name: declaration.name,
          kind: declaration.variantKind,
          ...(declaration.variantKind === 'enum'
            ? { values: Object.freeze([...declaration.values]) }
            : {}),
          fallback: declaration.fallback
        })
      );
    }
  }

  const resolveType = (name: string, span: SourceSpan): ShaderTypeId => {
    const normalized = name.replace(/\s+/g, '');
    if (BUILTIN_SCALARS.has(normalized) || structs.has(normalized))
      return normalized as ShaderTypeId;
    const vector = /^vec([234])<(.+)>$/.exec(normalized);
    if (vector && BUILTIN_SCALARS.has(vector[2]!)) return normalized as ShaderTypeId;
    const matrix = /^mat([234])x([234])<f32>$/.exec(normalized);
    if (matrix) return normalized as ShaderTypeId;
    const array = /^array<(.+),(\d+)>$/.exec(normalized);
    if (array) {
      const element = resolveType(array[1]!, span);
      return element === ERROR_TYPE ? ERROR_TYPE : (normalized as ShaderTypeId);
    }
    if (
      /^texture[_A-Za-z0-9]*(?:<.+>)?$/.test(normalized) ||
      /^sampler(?:_comparison)?$/.test(normalized)
    )
      return normalized as ShaderTypeId;
    diagnostics.push(typeDiagnostic('FLUX_UNKNOWN_TYPE', `Unknown shader type "${name}".`, span));
    return ERROR_TYPE;
  };

  for (const struct of structs.values()) {
    const fields = struct.fields.map((field) =>
      Object.freeze({
        name: field.name,
        type: field.type.name,
        typeId: resolveType(field.type.name, field.type.span),
        span: field.span
      })
    );
    types.push(
      Object.freeze({
        kind: 'struct',
        id: struct.name as ShaderTypeId,
        name: struct.name,
        fields: Object.freeze(fields),
        span: struct.span
      })
    );
  }

  let nextSymbol = 1;
  let nextFunction = 1;
  const globals: ShaderGlobalIR[] = [];
  const globalSymbols = new Map<string, SymbolInfo>();
  const bindings = new Map<string, ShaderGlobalIR>();
  for (const declaration of declarations) {
    if (declaration.kind !== 'global') continue;
    const type = resolveType(declaration.type.name, declaration.type.span);
    const id = nextSymbol++ as ShaderSymbolId;
    const previous = globalSymbols.get(declaration.name);
    if (previous)
      diagnostics.push(
        relatedDiagnostic(
          'FLUX_DUPLICATE_SYMBOL',
          `Symbol "${declaration.name}" is already declared.`,
          declaration.span,
          previous.span
        )
      );
    else
      globalSymbols.set(declaration.name, {
        id,
        name: declaration.name,
        type,
        mutable: declaration.addressSpace !== 'uniform' && declaration.addressSpace !== 'handle',
        span: declaration.span
      });
    const group = attributeValue(declaration, 'group');
    const binding = attributeValue(declaration, 'binding');
    const location = attributeValue(declaration, 'location');
    const addressSpace = ADDRESS_SPACES.has(declaration.addressSpace)
      ? (declaration.addressSpace as ShaderGlobalIR['addressSpace'])
      : 'private';
    if (!ADDRESS_SPACES.has(declaration.addressSpace))
      diagnostics.push(
        typeDiagnostic(
          'FLUX_INVALID_ADDRESS_SPACE',
          `Invalid address space "${declaration.addressSpace}".`,
          declaration.span
        )
      );
    if (
      ((addressSpace === 'uniform' || addressSpace === 'handle') &&
        declaration.access !== 'read') ||
      (addressSpace !== 'storage' &&
        declaration.access === 'read_write' &&
        addressSpace !== 'private' &&
        addressSpace !== 'in' &&
        addressSpace !== 'out')
    )
      diagnostics.push(
        typeDiagnostic(
          'FLUX_INVALID_ACCESS',
          `Address space "${addressSpace}" does not support ${declaration.access} access.`,
          declaration.span
        )
      );
    if (declaration.access !== 'read' && declaration.access !== 'read_write')
      diagnostics.push(
        typeDiagnostic(
          'FLUX_INVALID_ACCESS',
          `Unknown access mode "${declaration.access}".`,
          declaration.span
        )
      );
    const global = Object.freeze({
      id,
      name: declaration.name,
      type: declaration.type.name,
      typeId: type,
      addressSpace,
      access: declaration.access === 'read_write' ? ('read_write' as const) : ('read' as const),
      ...(group === undefined ? {} : { group }),
      ...(binding === undefined ? {} : { binding }),
      ...(location === undefined ? {} : { location }),
      span: declaration.span
    });
    globals.push(global);
    if (group !== undefined && binding !== undefined) {
      const key = `${group}:${binding}`;
      const existing = bindings.get(key);
      if (existing)
        diagnostics.push(
          relatedDiagnostic(
            'FLUX_DUPLICATE_BINDING',
            `Binding ${key} is declared by both "${existing.name}" and "${global.name}".`,
            global.span,
            existing.span
          )
        );
      else bindings.set(key, global);
    }
  }

  const functions = new Map<string, FunctionInfo>();
  for (const declaration of declarations) {
    if (declaration.kind !== 'function') continue;
    const info: FunctionInfo = Object.freeze({
      id: nextFunction++ as ShaderFunctionId,
      declaration,
      parameters: Object.freeze(
        declaration.parameters.map((parameter) =>
          resolveType(parameter.type.name, parameter.type.span)
        )
      ),
      ...(declaration.returnType
        ? { returnType: resolveType(declaration.returnType.name, declaration.returnType.span) }
        : {})
    });
    const existing = functions.get(declaration.name);
    if (existing)
      diagnostics.push(
        relatedDiagnostic(
          'FLUX_DUPLICATE_SYMBOL',
          `Function "${declaration.name}" is already declared.`,
          declaration.span,
          existing.declaration.span
        )
      );
    else functions.set(declaration.name, info);
  }

  const loweredFunctions: ShaderFunctionIR[] = [];
  const entries: ShaderEntryPointIR[] = [];
  for (const info of functions.values()) {
    const analyzer = new FunctionAnalyzer(
      info,
      structs,
      globalSymbols,
      functions,
      resolveType,
      diagnostics,
      nextSymbol
    );
    const lowered = analyzer.lower();
    nextSymbol = analyzer.nextSymbol;
    if (info.declaration.stage) {
      const returnLocation = attributeValueFromList(info.declaration.returnAttributes, 'location');
      if (
        info.declaration.stage === 'compute' &&
        (lowered.parameters.length > 0 ||
          lowered.returnType !== undefined ||
          returnLocation !== undefined ||
          lowered.parameters.some((parameter) => parameter.location !== undefined))
      )
        diagnostics.push(
          typeDiagnostic(
            'FLUX_INVALID_ENTRY_SIGNATURE',
            'Compute entry points cannot use location parameters or return values.',
            info.declaration.span
          )
        );
      entries.push(
        Object.freeze({
          ...lowered,
          stage: info.declaration.stage,
          ...(returnLocation === undefined ? {} : { returnLocation })
        })
      );
    } else loweredFunctions.push(lowered);
  }

  if (diagnostics.length > 0) return Object.freeze({ diagnostics: Object.freeze(diagnostics) });
  const spans = collectSpans(types, globals, loweredFunctions, entries);
  const ir: ShaderModuleIR = Object.freeze({
    version: 1,
    types: Object.freeze(types),
    globals: Object.freeze(globals),
    functions: Object.freeze(loweredFunctions),
    entryPoints: Object.freeze(entries),
    variants: Object.freeze(variants),
    sourceMap: Object.freeze({ spans }),
    sourceClosureHash
  });
  return Object.freeze({ ir, diagnostics: Object.freeze([]) });
}

class FunctionAnalyzer {
  private readonly scopes: Array<Map<string, SymbolInfo>> = [new Map()];
  private loopDepth = 0;
  constructor(
    private readonly info: FunctionInfo,
    private readonly structs: ReadonlyMap<string, FluxStructNode>,
    private readonly globals: ReadonlyMap<string, SymbolInfo>,
    private readonly functions: ReadonlyMap<string, FunctionInfo>,
    private readonly resolveType: (name: string, span: SourceSpan) => ShaderTypeId,
    private readonly diagnostics: ShaderDiagnostic[],
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
        const value = statement.value ? this.lowerExpression(statement.value) : undefined;
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
        const target = this.lowerExpression(statement.target);
        const value = this.lowerExpression(statement.value);
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
        const condition = this.lowerExpression(statement.condition);
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
        const selector = this.lowerExpression(statement.selector);
        const cases: ShaderSwitchCaseIR[] = statement.cases.map((case_) => {
          const selectors = case_.selectors.map((value) => this.lowerExpression(value));
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
        const condition = this.lowerExpression(statement.condition);
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
        const value = statement.value ? this.lowerExpression(statement.value) : undefined;
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
          expression: this.lowerExpression(statement.expression),
          span: statement.span
        });
    }
  }

  private lowerExpression(expression: FluxExpressionNode): ShaderExpressionIR {
    switch (expression.kind) {
      case 'literal':
        return Object.freeze({
          kind: 'literal',
          value: expression.value,
          type: expression.literalType as ShaderTypeId,
          span: expression.span
        });
      case 'name': {
        const symbol = this.lookup(expression.name);
        if (!symbol) {
          this.diagnostics.push(
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
        const operand = this.lowerExpression(expression.operand);
        if (expression.operator === '!' && operand.type !== 'bool')
          this.diagnostics.push(
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
        return this.lowerBinary(expression);
      case 'call':
        return this.lowerCall(expression);
      case 'field': {
        const base = this.lowerExpression(expression.base);
        let type = ERROR_TYPE;
        const struct = this.structs.get(base.type);
        const field = struct?.fields.find((candidate) => candidate.name === expression.field);
        if (field) type = this.resolveType(field.type.name, field.type.span);
        else {
          const vector = /^vec([234])<(.+)>$/.exec(base.type);
          if (vector && /^[xyzwrgba]{1,4}$/.test(expression.field))
            type =
              expression.field.length === 1
                ? (vector[2] as ShaderTypeId)
                : (`vec${expression.field.length}<${vector[2]}>` as ShaderTypeId);
          else
            this.diagnostics.push(
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
        const base = this.lowerExpression(expression.base);
        const index = this.lowerExpression(expression.index);
        let type = ERROR_TYPE;
        const array = /^array<(.+),(\d+)>$/.exec(base.type);
        const vector = /^vec[234]<(.+)>$/.exec(base.type);
        const matrix = /^mat[234]x([234])<(.+)>$/.exec(base.type);
        if (array) type = array[1] as ShaderTypeId;
        else if (vector) type = vector[1] as ShaderTypeId;
        else if (matrix) type = `vec${matrix[1]}<${matrix[2]}>` as ShaderTypeId;
        else
          this.diagnostics.push(
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
          this.diagnostics.push(
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

  private lowerBinary(
    expression: Extract<FluxExpressionNode, { kind: 'binary' }>
  ): ShaderExpressionIR {
    const left = this.lowerExpression(expression.left);
    const right = this.lowerExpression(expression.right);
    const comparison = ['==', '!=', '<', '<=', '>', '>='].includes(expression.operator);
    const logical = expression.operator === '&&' || expression.operator === '||';
    if (logical && (left.type !== 'bool' || right.type !== 'bool'))
      this.diagnostics.push(
        typeDiagnostic(
          'FLUX_OPERAND_TYPE',
          `Operator ${expression.operator} requires bool operands.`,
          expression.span
        )
      );
    else if (!logical && !compatible(left.type, right.type))
      this.diagnostics.push(
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
      type: comparison || logical ? ('bool' as ShaderTypeId) : left.type,
      span: expression.span
    });
  }

  private lowerCall(expression: Extract<FluxExpressionNode, { kind: 'call' }>): ShaderExpressionIR {
    const arguments_ = Object.freeze(
      expression.arguments.map((argument) => this.lowerExpression(argument))
    );
    const typeName =
      expression.typeArguments.length > 0
        ? `${expression.callee}<${expression.typeArguments.map((type) => type.name).join(',')}>`
        : expression.callee;
    if (isConstructorName(expression.callee, expression.typeArguments.length > 0, this.structs)) {
      const type = this.resolveType(typeName, expression.span);
      return Object.freeze({
        kind: 'construct',
        arguments: arguments_,
        type,
        span: expression.span
      });
    }
    const function_ = this.functions.get(expression.callee);
    if (function_) {
      if (
        function_.parameters.length !== arguments_.length ||
        function_.parameters.some(
          (type, index) => !compatible(type, arguments_[index]?.type ?? ERROR_TYPE)
        )
      )
        this.diagnostics.push(
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
    this.diagnostics.push(
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
  private lookup(name: string): SymbolInfo | undefined {
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

function compatible(expected: ShaderTypeId, actual: ShaderTypeId): boolean {
  return expected === ERROR_TYPE || actual === ERROR_TYPE || expected === actual;
}
function isConstructorName(
  name: string,
  generic: boolean,
  structs: ReadonlyMap<string, FluxStructNode>
): boolean {
  return (
    structs.has(name) ||
    BUILTIN_SCALARS.has(name) ||
    (generic && (/^vec[234]$/.test(name) || /^mat[234]x[234]$/.test(name) || name === 'array'))
  );
}
function inferIntrinsic(
  name: string,
  args: readonly ShaderExpressionIR[]
): ShaderTypeId | undefined {
  if (['abs', 'min', 'max', 'clamp', 'normalize'].includes(name) && args.length > 0)
    return args[0]!.type;
  if (['dot', 'length', 'distance'].includes(name) && args.length > 0) return 'f32' as ShaderTypeId;
  return undefined;
}
function attributeValue(
  declaration: Extract<FluxDeclarationNode, { kind: 'global' }>,
  name: string
): number | undefined {
  return attributeValueFromList(declaration.attributes, name);
}
function attributeValueFromList(
  attributes: readonly { readonly name: string; readonly value?: number }[],
  name: string
): number | undefined {
  return attributes.find((attribute) => attribute.name === name)?.value;
}
function typeDiagnostic(code: string, message: string, primary: SourceSpan): ShaderDiagnostic {
  return Object.freeze({
    severity: 'error',
    code,
    message,
    stage: 'typecheck',
    primary,
    related: Object.freeze([])
  });
}
function relatedDiagnostic(
  code: string,
  message: string,
  primary: SourceSpan,
  related: SourceSpan
): ShaderDiagnostic {
  return Object.freeze({
    ...typeDiagnostic(code, message, primary),
    related: Object.freeze([related])
  });
}
function collectSpans(
  types: readonly ShaderStructTypeIR[],
  globals: readonly ShaderGlobalIR[],
  functions: readonly ShaderFunctionIR[],
  entries: readonly ShaderEntryPointIR[]
): readonly SourceSpan[] {
  const spans: SourceSpan[] = [];
  for (const type of types) {
    if (type.span) spans.push(type.span);
    for (const field of type.fields) if (field.span) spans.push(field.span);
  }
  spans.push(...globals.map((global) => global.span));
  const visit = (statements: readonly ShaderStatementIR[]) => {
    for (const statement of statements) {
      spans.push(statement.span);
      if (statement.kind === 'if') {
        visit(statement.then);
        if (statement.otherwise) visit(statement.otherwise);
      } else if (statement.kind === 'switch')
        for (const case_ of statement.cases) {
          spans.push(case_.span);
          visit(case_.body);
        }
      else if (statement.kind === 'loop') {
        visit(statement.body);
        visit(statement.continuing);
      } else if (statement.kind === 'while') visit(statement.body);
    }
  };
  for (const function_ of [...functions, ...entries]) {
    spans.push(function_.span, ...function_.parameters.map((parameter) => parameter.span));
    visit(function_.body);
  }
  return Object.freeze(spans);
}
