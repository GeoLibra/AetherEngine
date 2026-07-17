import { canonicalStringify, stableHash } from './hash';
import type { ShaderVariantDimension } from './types';

export interface ResolvedShaderVariants {
  readonly ok: true;
  readonly values: Readonly<Record<string, boolean | string | number>>;
  readonly key: Readonly<{ value: string; hash: string }>;
}
export interface ShaderVariantError {
  readonly ok: false;
  readonly error: Readonly<{
    code:
      | 'VARIANT_UNKNOWN'
      | 'VARIANT_INVALID_VALUE'
      | 'VARIANT_MUTEX_CONFLICT'
      | 'VARIANT_CAPABILITY_REQUIRED';
    dimension: string;
    message: string;
  }>;
}

export function resolveShaderVariants(
  dimensions: readonly ShaderVariantDimension[],
  request: Readonly<Record<string, boolean | string | number>>,
  capabilities: ReadonlySet<string>
): ResolvedShaderVariants | ShaderVariantError {
  const known = new Set(dimensions.map((value) => value.name));
  const unknown = Object.keys(request).find((name) => !known.has(name));
  if (unknown) return failure('VARIANT_UNKNOWN', unknown, `Unknown shader variant "${unknown}".`);
  const values: Record<string, boolean | string | number> = {};
  for (const dimension of [...dimensions].sort((a, b) => a.name.localeCompare(b.name))) {
    const value = request[dimension.name] ?? dimension.fallback;
    if (dimension.kind === 'boolean' && typeof value !== 'boolean')
      return failure(
        'VARIANT_INVALID_VALUE',
        dimension.name,
        `Variant "${dimension.name}" requires a boolean.`
      );
    if (dimension.kind === 'enum' && !dimension.values?.includes(String(value)))
      return failure(
        'VARIANT_INVALID_VALUE',
        dimension.name,
        `Variant "${dimension.name}" does not accept "${value}".`
      );
    const required = dimension.requires?.[String(value)] ?? [];
    const missing = required.find((capability) => !capabilities.has(capability));
    if (missing)
      return failure(
        'VARIANT_CAPABILITY_REQUIRED',
        dimension.name,
        `Variant "${dimension.name}=${value}" requires capability "${missing}".`
      );
    values[dimension.name] = value;
  }
  for (const dimension of dimensions)
    if (truthy(values[dimension.name]))
      for (const other of dimension.mutex ?? [])
        if (truthy(values[other]))
          return failure(
            'VARIANT_MUTEX_CONFLICT',
            dimension.name,
            `Variants "${dimension.name}" and "${other}" are mutually exclusive.`
          );
  const frozen = Object.freeze(values);
  const value = canonicalStringify(frozen);
  return Object.freeze({
    ok: true,
    values: frozen,
    key: Object.freeze({ value, hash: stableHash(value) })
  });
}

function truthy(value: boolean | string | number | undefined): boolean {
  return (
    value !== undefined && value !== false && value !== 0 && value !== 'false' && value !== 'off'
  );
}
function failure(
  code: ShaderVariantError['error']['code'],
  dimension: string,
  message: string
): ShaderVariantError {
  return Object.freeze({ ok: false, error: Object.freeze({ code, dimension, message }) });
}
