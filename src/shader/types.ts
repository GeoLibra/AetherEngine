import type { ShaderEntryPointIR, ShaderFunctionIR, ShaderSymbolId, ShaderTypeId } from './ir';

export type ShaderTarget = 'wgsl' | 'glsl300es';
export type ShaderScalarKind = 'f32' | 'i32' | 'u32' | 'bool32';

export interface SourceSpan {
  readonly uri: string;
  readonly line: number;
  readonly column: number;
  readonly length: number;
}

export interface ShaderDiagnostic {
  readonly severity: 'info' | 'warning' | 'error';
  readonly code: string;
  readonly message: string;
  readonly stage:
    | 'resolve'
    | 'parse'
    | 'typecheck'
    | 'layout'
    | 'capability'
    | 'emit'
    | 'backend-validation'
    | 'cache';
  readonly primary: SourceSpan;
  readonly related: readonly SourceSpan[];
  readonly backendLog?: string;
}

export interface ShaderSourceRef {
  readonly uri: string;
  readonly languageVersion: number;
}

export interface ShaderSourceResolver {
  load(uri: string): Promise<string>;
}

export interface ShaderSourceModule {
  readonly uri: string;
  readonly content: string;
  readonly contentHash: string;
}

export interface ShaderIncludeReference {
  readonly from: string;
  readonly to: string;
  readonly span: SourceSpan;
}

export interface ResolvedShaderSource {
  readonly root: ShaderSourceRef;
  readonly modules: readonly ShaderSourceModule[];
  readonly references: readonly ShaderIncludeReference[];
  readonly hash: string;
}

export interface ShaderStructFieldIR {
  readonly name: string;
  readonly type: string;
  readonly typeId?: ShaderTypeId;
  readonly span?: SourceSpan;
}

export interface ShaderStructTypeIR {
  readonly kind: 'struct';
  readonly name: string;
  readonly fields: readonly ShaderStructFieldIR[];
  readonly id?: ShaderTypeId;
  readonly span?: SourceSpan;
}

export type ShaderTypeIR = ShaderStructTypeIR;

export interface ShaderGlobalIR {
  readonly id?: ShaderSymbolId;
  readonly name: string;
  readonly type: string;
  readonly typeId?: ShaderTypeId;
  readonly addressSpace: 'uniform' | 'storage' | 'in' | 'out' | 'handle' | 'private';
  readonly access: 'read' | 'read_write';
  readonly group?: number;
  readonly binding?: number;
  readonly location?: number;
  readonly span: SourceSpan;
}

export interface ShaderVariantDimension {
  readonly name: string;
  readonly kind: 'boolean' | 'enum';
  readonly values?: readonly string[];
  readonly fallback: boolean | string | number;
  readonly mutex?: readonly string[];
  readonly requires?: Readonly<Record<string, readonly string[]>>;
}

export interface ShaderSourceMap {
  readonly spans: readonly SourceSpan[];
}

export interface ShaderModuleIR {
  readonly version: number;
  readonly types: readonly ShaderTypeIR[];
  readonly globals: readonly ShaderGlobalIR[];
  readonly functions: readonly ShaderFunctionIR[];
  readonly entryPoints: readonly ShaderEntryPointIR[];
  readonly variants: readonly ShaderVariantDimension[];
  readonly sourceMap: ShaderSourceMap;
  readonly sourceClosureHash: string;
}

export interface BufferFieldLayout {
  readonly path: string;
  readonly offset: number;
  readonly size: number;
  readonly alignment: number;
  readonly stride?: number;
  readonly scalarKind: ShaderScalarKind;
  readonly elementCount: number;
}

export interface BufferLayoutManifest {
  readonly name: string;
  readonly shaderAbiVersion: number;
  readonly target: ShaderTarget;
  readonly addressSpace: 'uniform' | 'storage';
  readonly access: 'read' | 'read_write';
  readonly policy: import('./layout-policy').ShaderLayoutPolicyId;
  readonly byteSize: number;
  readonly alignment: number;
  readonly fields: readonly BufferFieldLayout[];
  readonly layoutHash: string;
}

export interface BindingGroupManifest {
  readonly group: number;
  readonly entries: readonly Readonly<{ binding: number; name: string; kind: string }>[];
}

export interface ShaderBindingManifest {
  readonly groups: readonly BindingGroupManifest[];
  readonly buffers: readonly BufferLayoutManifest[];
  readonly vertexInputs: readonly Readonly<{ location: number; name: string; type: string }>[];
  readonly fragmentOutputs: readonly Readonly<{ location: number; name: string; type: string }>[];
  readonly layoutHash: string;
}

export interface ShaderCompileRequest {
  readonly revision: number;
  readonly source: ShaderSourceRef;
  readonly entries: readonly string[];
  readonly target: ShaderTarget;
  readonly variants: Readonly<Record<string, boolean | string | number>>;
  readonly capabilities: readonly string[];
  readonly signal?: AbortSignal;
}

export type {
  ShaderBinaryExpressionIR,
  ShaderCallExpressionIR,
  ShaderConstructExpressionIR,
  ShaderEntryPointIR,
  ShaderExpressionIR,
  ShaderFieldExpressionIR,
  ShaderFunctionId,
  ShaderFunctionIR,
  ShaderIndexExpressionIR,
  ShaderIntrinsicExpressionIR,
  ShaderLiteralExpressionIR,
  ShaderParameterIR,
  ShaderStatementIR,
  ShaderSwitchCaseIR,
  ShaderSymbolExpressionIR,
  ShaderSymbolId,
  ShaderTypeId,
  ShaderUnaryExpressionIR
} from './ir';
