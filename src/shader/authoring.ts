/**
 * @file Closed authoring source construction and metadata validation functions.
 */

import type {
  DefineShaderAuthoringSourceOptions,
  ShaderAuthoringSource,
  ShaderSourceKind,
  WgslCapabilityRequirement,
  WgslCookPolicy,
  WgslEntryMetadata,
  WgslImportRef,
  WgslMaterialBindingMetadata,
  WgslShaderMetadata,
  WgslVariantDimension
} from './types';

/**
 * Checks whether a URI is a strictly valid canonical shader source URI matching native cooker rules.
 *
 * Rules:
 * 1. Must start with 'asset://' or 'package://'.
 * 2. Path after prefix must be non-empty.
 * 3. Path must not contain '\', '?', '#', '%', or ASCII control characters.
 * 4. Segments split by '/' must each be non-empty, and no segment may be '.' or '..'.
 *
 * @param uri Candidate URI string.
 * @returns True if valid canonical URI, false otherwise.
 */
export function isValidCanonicalShaderSourceUri(uri: string): boolean {
  if (typeof uri !== 'string') return false;

  let path: string;
  if (uri.startsWith('asset://')) {
    path = uri.slice('asset://'.length);
  } else if (uri.startsWith('package://')) {
    path = uri.slice('package://'.length);
  } else {
    return false;
  }

  if (path.length === 0) return false;

  // Forbidden characters: backslash, query, fragment, percent-encoding, control characters
  if (/[\x00-\x1F\x7F\\?#%]/u.test(path)) {
    return false;
  }

  const segments = path.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..') {
      return false;
    }
  }

  return true;
}

/**
 * Asserts that a URI is a strictly valid canonical shader source URI.
 *
 * @param uri Candidate URI string.
 * @throws {Error} If URI is invalid.
 */
export function assertValidCanonicalShaderSourceUri(uri: string): void {
  if (!isValidCanonicalShaderSourceUri(uri)) {
    throw new Error(
      `Shader authoring source URI must be a canonical URI starting with 'asset://' or 'package://' without relative traversal, query, fragment, backslashes, or percent-encoding, received: "${uri}"`
    );
  }
}

/**
 * Defines and validates an immutable ShaderAuthoringSource.
 *
 * @param options Source parameters. `kind` defaults to `'wgsl'`.
 * @returns An immutable, validated ShaderAuthoringSource.
 * @throws {Error} When URI is not a canonical `asset://` or `package://` URI or when source kind is unsupported.
 */
export function defineShaderAuthoringSource(
  options: DefineShaderAuthoringSourceOptions
): ShaderAuthoringSource {
  if (!options || typeof options !== 'object') {
    throw new Error('Shader authoring source options must be a non-null object.');
  }

  const { uri, kind = 'wgsl', languageVersion } = options;

  assertValidCanonicalShaderSourceUri(uri);

  const validKinds: readonly ShaderSourceKind[] = Object.freeze([
    'wgsl',
    'flux-experimental',
    'shader-graph'
  ]);
  if (!validKinds.includes(kind)) {
    throw new Error(`Unsupported shader source kind "${kind}". Allowed: ${validKinds.join(', ')}`);
  }

  const resolvedLanguageVersion =
    languageVersion ??
    (kind === 'wgsl' ? 'wgsl-1' : kind === 'flux-experimental' ? 'flux-1' : 'graph-1');

  return Object.freeze({
    kind,
    uri,
    languageVersion: resolvedLanguageVersion
  });
}

const ALLOWED_METADATA_KEYS = new Set([
  'schemaVersion',
  'entryPoints',
  'imports',
  'variants',
  'capabilityRequirements',
  'materialBindings',
  'cookPolicy'
]);

const VALID_STAGES = new Set(['vertex', 'fragment', 'compute']);

/**
 * Validates untrusted WGSL sidecar metadata against the schema, returning a defensively copied and frozen snapshot.
 *
 * @param value Untrusted JSON value.
 * @returns Frozen WgslShaderMetadata snapshot.
 * @throws {Error} On schema violations, unknown keys, duplicate entry points, or malformed fields.
 */
export function validateWgslShaderMetadata(value: unknown): WgslShaderMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('WGSL shader metadata must be a non-null object.');
  }

  const raw = value as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_METADATA_KEYS.has(key)) {
      throw new Error(`Unknown metadata field "${key}".`);
    }
  }

  if (raw.schemaVersion !== 1) {
    throw new Error(`Unsupported schemaVersion ${String(raw.schemaVersion)}. Expected 1.`);
  }

  let frozenEntryPoints: readonly WgslEntryMetadata[] | undefined;
  if (raw.entryPoints !== undefined) {
    if (!Array.isArray(raw.entryPoints)) {
      throw new Error('Metadata entryPoints must be an array when provided.');
    }

    const entryNames = new Set<string>();
    const entries: WgslEntryMetadata[] = [];

    for (const entry of raw.entryPoints) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error('Each entryPoint must be a non-null object.');
      }
      const { name, stage, label } = entry as Record<string, unknown>;
      if (typeof name !== 'string' || name.trim().length === 0) {
        throw new Error('Entry point name must be a non-empty string.');
      }
      if (entryNames.has(name)) {
        throw new Error(`Duplicate entry point name "${name}" in metadata.`);
      }
      entryNames.add(name);

      if (typeof stage !== 'string' || !VALID_STAGES.has(stage)) {
        throw new Error(
          `Invalid stage "${String(stage)}" for entry point "${name}". Must be vertex, fragment, or compute.`
        );
      }

      entries.push(
        Object.freeze({
          name,
          stage: stage as 'vertex' | 'fragment' | 'compute',
          ...(typeof label === 'string' ? { label } : {})
        })
      );
    }
    frozenEntryPoints = Object.freeze(entries);
  }

  let frozenImports: readonly WgslImportRef[] | undefined;
  if (raw.imports !== undefined) {
    if (!Array.isArray(raw.imports)) {
      throw new Error('Metadata imports must be an array when provided.');
    }
    frozenImports = Object.freeze(
      raw.imports.map((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          throw new Error('Import entry must be an object.');
        }
        const { path, alias } = item as Record<string, unknown>;
        if (typeof path !== 'string' || !path.trim()) {
          throw new Error('Import path must be a non-empty string.');
        }
        return Object.freeze({
          path,
          ...(typeof alias === 'string' ? { alias } : {})
        });
      })
    );
  }

  const VALID_OPTIMIZATIONS = new Set(['none', 'size', 'performance']);
  const ALLOWED_COOK_POLICY_KEYS = new Set(['optimization', 'preserveNames']);

  let frozenVariants: readonly WgslVariantDimension[] | undefined;
  if (raw.variants !== undefined) {
    if (!Array.isArray(raw.variants)) {
      throw new Error('Metadata variants must be an array when provided.');
    }
    const variantNames = new Set<string>();
    frozenVariants = Object.freeze(
      raw.variants.map((dim) => {
        if (!dim || typeof dim !== 'object' || Array.isArray(dim)) {
          throw new Error('Variant dimension must be an object.');
        }
        const { name, values, defaultValue } = dim as Record<string, unknown>;
        if (typeof name !== 'string' || !name.trim()) {
          throw new Error('Variant dimension name must be a non-empty string.');
        }
        if (variantNames.has(name)) {
          throw new Error(`Duplicate variant dimension name "${name}" in metadata.`);
        }
        variantNames.add(name);

        if (!Array.isArray(values) || values.length === 0) {
          throw new Error(`Variant dimension "${name}" must have a non-empty values array.`);
        }

        const seenValues = new Set<string>();
        const stringValues: string[] = [];
        for (const v of values) {
          if (typeof v !== 'string' || !v.trim()) {
            throw new Error(`Variant dimension "${name}" value must be a non-empty string.`);
          }
          if (seenValues.has(v)) {
            throw new Error(`Duplicate value "${v}" in variant dimension "${name}".`);
          }
          seenValues.add(v);
          stringValues.push(v);
        }

        if (defaultValue !== undefined) {
          if (typeof defaultValue !== 'string' || !defaultValue.trim()) {
            throw new Error(
              `Variant dimension "${name}" defaultValue must be a non-empty string when provided.`
            );
          }
          if (!seenValues.has(defaultValue)) {
            throw new Error(
              `Default value "${defaultValue}" for variant dimension "${name}" must be one of [${stringValues.join(', ')}].`
            );
          }
        }

        return Object.freeze({
          name,
          values: Object.freeze(stringValues),
          ...(defaultValue !== undefined ? { defaultValue } : {})
        });
      })
    );
  }

  let frozenCapabilities: readonly WgslCapabilityRequirement[] | undefined;
  if (raw.capabilityRequirements !== undefined) {
    if (!Array.isArray(raw.capabilityRequirements)) {
      throw new Error('Metadata capabilityRequirements must be an array when provided.');
    }
    frozenCapabilities = Object.freeze(
      raw.capabilityRequirements.map((cap) => {
        if (!cap || typeof cap !== 'object' || Array.isArray(cap)) {
          throw new Error('Capability requirement must be an object.');
        }
        const { feature, fallback } = cap as Record<string, unknown>;
        if (typeof feature !== 'string' || !feature.trim()) {
          throw new Error('Capability feature must be a non-empty string.');
        }
        if (fallback !== undefined && (typeof fallback !== 'string' || !fallback.trim())) {
          throw new Error('Capability fallback must be a non-empty string when provided.');
        }
        return Object.freeze({
          feature,
          ...(fallback !== undefined ? { fallback } : {})
        });
      })
    );
  }

  let frozenMaterialBindings: readonly WgslMaterialBindingMetadata[] | undefined;
  if (raw.materialBindings !== undefined) {
    if (!Array.isArray(raw.materialBindings)) {
      throw new Error('Metadata materialBindings must be an array when provided.');
    }
    frozenMaterialBindings = Object.freeze(
      raw.materialBindings.map((mb) => {
        if (!mb || typeof mb !== 'object' || Array.isArray(mb)) {
          throw new Error('Material binding must be an object.');
        }
        const { binding, property } = mb as Record<string, unknown>;
        if (typeof binding !== 'string' || !binding.trim()) {
          throw new Error('Material binding name must be a non-empty string.');
        }
        if (typeof property !== 'string' || !property.trim()) {
          throw new Error('Material binding property must be a non-empty string.');
        }
        return Object.freeze({ binding, property });
      })
    );
  }

  let frozenCookPolicy: WgslCookPolicy | undefined;
  if (raw.cookPolicy !== undefined) {
    if (!raw.cookPolicy || typeof raw.cookPolicy !== 'object' || Array.isArray(raw.cookPolicy)) {
      throw new Error('Metadata cookPolicy must be an object when provided.');
    }
    const cookPolicyRaw = raw.cookPolicy as Record<string, unknown>;
    for (const key of Object.keys(cookPolicyRaw)) {
      if (!ALLOWED_COOK_POLICY_KEYS.has(key)) {
        throw new Error(`Unknown cookPolicy field "${key}".`);
      }
    }
    const { optimization, preserveNames } = cookPolicyRaw;
    if (optimization !== undefined) {
      if (typeof optimization !== 'string' || !VALID_OPTIMIZATIONS.has(optimization)) {
        throw new Error(
          `Invalid optimization "${String(optimization)}" in cookPolicy. Expected "none", "size", or "performance".`
        );
      }
    }
    if (preserveNames !== undefined && typeof preserveNames !== 'boolean') {
      throw new Error('Invalid preserveNames in cookPolicy. Expected boolean.');
    }
    frozenCookPolicy = Object.freeze({
      ...(optimization !== undefined
        ? { optimization: optimization as 'none' | 'size' | 'performance' }
        : {}),
      ...(preserveNames !== undefined ? { preserveNames } : {})
    });
  }

  return Object.freeze({
    schemaVersion: 1 as const,
    ...(frozenEntryPoints !== undefined ? { entryPoints: frozenEntryPoints } : {}),
    ...(frozenImports !== undefined ? { imports: frozenImports } : {}),
    ...(frozenVariants !== undefined ? { variants: frozenVariants } : {}),
    ...(frozenCapabilities !== undefined ? { capabilityRequirements: frozenCapabilities } : {}),
    ...(frozenMaterialBindings !== undefined ? { materialBindings: frozenMaterialBindings } : {}),
    ...(frozenCookPolicy !== undefined ? { cookPolicy: frozenCookPolicy } : {})
  });
}
