import type { SourceSpan } from '../types';
import type { ShaderEntryPointIR, ShaderFunctionIR } from './nodes';
import type { ShaderSymbolId, ShaderTypeId } from './symbols';

export interface ShaderStructFieldIR {
  readonly name: string;
  readonly type: string;
  readonly typeId?: ShaderTypeId;
  readonly builtin?: 'position';
  readonly location?: number;
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
