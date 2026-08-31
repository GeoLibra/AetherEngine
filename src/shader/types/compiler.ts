import type { ShaderBindingRequirement, ShaderTarget } from './manifest';
import type { ShaderSourceRef } from './source';

export interface ShaderCompileRequest {
  readonly revision: number;
  readonly source: ShaderSourceRef;
  readonly entries: readonly string[];
  readonly target: ShaderTarget;
  readonly variants: Readonly<Record<string, boolean | string | number>>;
  readonly capabilities: readonly string[];
  readonly bindingRequirements?: readonly ShaderBindingRequirement[];
  readonly signal?: AbortSignal;
}
