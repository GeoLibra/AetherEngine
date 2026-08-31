import type { FluxDeclarationNode, FluxModuleNode, FluxStructNode } from '../../types';
import type {
  ShaderEntryPointIR,
  ShaderFunctionId,
  ShaderFunctionIR,
  ShaderGlobalIR,
  ShaderSymbolId,
  ShaderTypeId
} from '../../ir';
import type {
  ShaderDiagnostic,
  ShaderModuleIR,
  ShaderStructTypeIR,
  ShaderVariantDimension,
  SourceSpan
} from '../../types';
import { FunctionAnalyzer } from './stmt-lower';
import {
  ADDRESS_SPACES,
  attributeValue,
  attributeValueFromList,
  BUILTIN_SCALARS,
  collectSpans,
  ERROR_TYPE,
  FunctionInfo,
  NO_SHADER_DIAGNOSTICS,
  relatedDiagnostic,
  SymbolInfo,
  typeDiagnostic
} from './type-context';

export interface LowerResult {
  readonly ir?: ShaderModuleIR;
  readonly diagnostics: readonly ShaderDiagnostic[];
}

/**
 * Lowers, typechecks, and validates FluxSL AST modules into a unified compiled ShaderModuleIR.
 *
 * Verifications performed:
 * - Checks for duplicate structure types.
 * - Detects duplicate global variable bindings (groups and bindings collision check).
 * - Resolves all type definitions recursively (struct members, functions, parameters).
 * - Checks block scoping rules and name shadowing of local parameters and variables.
 * - Enforces correct type assignments on variable initializers, return statements, and operands.
 */
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
    const info: FunctionInfo = {
      id: nextFunction++ as ShaderFunctionId,
      declaration,
      parameters: declaration.parameters.map((parameter) =>
        resolveType(parameter.type.name, parameter.type.span)
      ),
      ...(declaration.returnType
        ? { returnType: resolveType(declaration.returnType.name, declaration.returnType.span) }
        : {})
    };
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
  return Object.freeze({ ir, diagnostics: NO_SHADER_DIAGNOSTICS });
}

export * from './type-context';
export * from './expr-lower';
export * from './stmt-lower';
