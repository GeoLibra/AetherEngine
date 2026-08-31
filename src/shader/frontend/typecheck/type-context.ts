import type { FluxDeclarationNode, FluxFunctionNode, FluxStructNode } from '../../types';
import type {
  ShaderEntryPointIR,
  ShaderExpressionIR,
  ShaderFunctionId,
  ShaderFunctionIR,
  ShaderStatementIR,
  ShaderSymbolId,
  ShaderTypeId
} from '../../ir';
import type { ShaderDiagnostic, ShaderGlobalIR, ShaderStructTypeIR, SourceSpan } from '../../types';

export interface SymbolInfo {
  readonly id: ShaderSymbolId;
  readonly name: string;
  readonly type: ShaderTypeId;
  readonly mutable: boolean;
  readonly span: SourceSpan;
}

export interface FunctionInfo {
  readonly id: ShaderFunctionId;
  readonly declaration: FluxFunctionNode;
  readonly parameters: readonly ShaderTypeId[];
  readonly returnType?: ShaderTypeId;
}

export const ERROR_TYPE = '<error>' as ShaderTypeId;
export const BUILTIN_SCALARS = new Set(['f32', 'i32', 'u32', 'bool']);
export const ADDRESS_SPACES = new Set(['uniform', 'storage', 'in', 'out', 'handle', 'private']);
export const NO_SHADER_DIAGNOSTICS: readonly ShaderDiagnostic[] = Object.freeze([]);
export const NO_RELATED_SPANS: readonly SourceSpan[] = Object.freeze([]);

export function compatible(expected: ShaderTypeId, actual: ShaderTypeId): boolean {
  return expected === ERROR_TYPE || actual === ERROR_TYPE || expected === actual;
}

export function isConstructorName(
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

export function inferIntrinsic(
  name: string,
  args: readonly ShaderExpressionIR[]
): ShaderTypeId | undefined {
  if (['abs', 'min', 'max', 'clamp', 'normalize'].includes(name) && args.length > 0)
    return args[0]!.type;
  if (['dot', 'length', 'distance'].includes(name) && args.length > 0) return 'f32' as ShaderTypeId;
  return undefined;
}

export function attributeValue(
  declaration: Extract<FluxDeclarationNode, { kind: 'global' }>,
  name: string
): number | undefined {
  return attributeValueFromList(declaration.attributes, name);
}

export function attributeValueFromList(
  attributes: readonly { readonly name: string; readonly value?: number | string }[],
  name: string
): number | undefined {
  const value = attributes.find((attribute) => attribute.name === name)?.value;
  return typeof value === 'number' ? value : undefined;
}

export function attributeStringValueFromList(
  attributes: readonly { readonly name: string; readonly value?: number | string }[],
  name: string
): string | undefined {
  const value = attributes.find((attribute) => attribute.name === name)?.value;
  return typeof value === 'string' ? value : undefined;
}

export function typeDiagnostic(
  code: string,
  message: string,
  primary: SourceSpan
): ShaderDiagnostic {
  return Object.freeze({
    severity: 'error',
    code,
    message,
    stage: 'typecheck',
    primary,
    related: NO_RELATED_SPANS
  });
}

export function relatedDiagnostic(
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

export function collectSpans(
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
