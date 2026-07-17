import { MaterialDiagnosticError } from './diagnostics';
import {
  cloneMaterialValue,
  commitMaterialParameterChanges,
  createMaterialParameterBlock,
  freezeMaterialValue,
  getMaterialParameterBlockState,
  materialValuesEqual
} from './parameter-block';
import { compareCodeUnits, getMaterialSchemaInternals } from './schema';
import { validateMaterialTechniques } from './technique-validation';
import type {
  MaterialAsset,
  MaterialAssetDefinition,
  MaterialAssetReference,
  MaterialDiagnostic,
  MaterialFieldDefinitions,
  MaterialInstance,
  MaterialInstanceSnapshot,
  MaterialOperationFailure,
  MaterialParameterBlock,
  MaterialParameterDraft,
  MaterialRebaseResult,
  MaterialSchema,
  MaterialValue,
  ResolvedMaterialAsset
} from './types';

const INSTANCE_STATES = new WeakMap<MaterialInstance, MaterialInstanceState>();
const MATERIAL_ASSETS = new WeakSet<object>();
const RESOLVED_MATERIAL_ASSETS = new WeakSet<object>();

interface MaterialInstanceState {
  readonly resolved: ResolvedMaterialAsset;
  readonly overrides: ReadonlyMap<string, MaterialValue>;
}

class ImmutableMaterialInstance implements MaterialInstance {
  constructor(
    readonly asset: MaterialAssetReference,
    readonly revision: number,
    readonly parameters: MaterialParameterBlock,
    readonly keywords: Readonly<Record<string, boolean | string | number>>,
    state: MaterialInstanceState
  ) {
    INSTANCE_STATES.set(this, state);
    Object.freeze(this);
  }

  edit(mutator: (draft: MaterialParameterDraft) => void): MaterialInstance {
    const state = requireInstanceState(this);
    const changes = new Map<number, MaterialValue>();
    const nextKeywords = new Map(Object.entries(this.keywords));
    let active = true;
    const draft: MaterialParameterDraft = Object.freeze({
      set: <T extends MaterialValue>(field: import('./types').MaterialField<T>, value: T) => {
        assertActive(active);
        this.parameters.get(field);
        changes.set(field.index, value);
      },
      setName: (name: string, value: MaterialValue) => {
        assertActive(active);
        const field = state.resolved.asset.schema.field(name);
        changes.set(field.index, value);
      },
      setKeyword: (name: string, value: boolean | string | number) => {
        assertActive(active);
        validateKeyword(state.resolved.asset.schema, name, value);
        nextKeywords.set(name, value);
      },
      removeKeyword: (name: string) => {
        assertActive(active);
        nextKeywords.delete(name);
      }
    });

    try {
      mutator(draft);
    } finally {
      active = false;
    }

    const parameters = commitMaterialParameterChanges(this.parameters, changes);
    const keywords = freezeKeywords(nextKeywords);
    const overrides = new Map(state.overrides);
    const definitions = getMaterialSchemaInternals(state.resolved.asset.schema).definitions;
    const nextValues = getMaterialParameterBlockState(parameters).values;
    const defaultValues = getMaterialParameterBlockState(state.resolved.asset.defaults).values;
    for (const index of changes.keys()) {
      const definition = definitions[index];
      const value = nextValues[index];
      if (definition === undefined || value === undefined) continue;
      if (materialValuesEqual(value, defaultValues[index])) overrides.delete(definition.fieldId);
      else overrides.set(definition.fieldId, value);
    }

    if (
      parameters === this.parameters &&
      materialValuesEqual(keywords, this.keywords) &&
      materialOverrideMapsEqual(overrides, state.overrides)
    ) {
      return this;
    }

    return createInstance(state.resolved, this.revision + 1, parameters, keywords, overrides);
  }

  rebase(resolved: ResolvedMaterialAsset): MaterialRebaseResult {
    const state = requireInstanceState(this);
    const diagnostic = validateRebase(state.resolved, resolved);
    if (diagnostic !== null) return failure(diagnostic);
    if (resolved.asset === state.resolved.asset) return success(this);

    const targetInternals = getMaterialSchemaInternals(resolved.asset.schema);
    const changes = new Map<number, MaterialValue>();
    for (const [fieldId, value] of state.overrides) {
      const field = targetInternals.fieldsById.get(fieldId);
      if (field === undefined)
        return failure(incompatible(resolved, `Missing field "${fieldId}".`));
      changes.set(field.index, value);
    }
    const parameters = commitMaterialParameterChanges(resolved.asset.defaults, changes);
    const values = getMaterialParameterBlockState(parameters).values;
    const overrides = new Map<string, MaterialValue>();
    for (const [fieldId] of state.overrides) {
      const field = targetInternals.fieldsById.get(fieldId);
      if (field === undefined) continue;
      const value = values[field.index];
      if (value !== undefined) overrides.set(fieldId, value);
    }
    return success(createInstance(resolved, this.revision, parameters, this.keywords, overrides));
  }
}

export function createMaterialAsset<const D extends MaterialFieldDefinitions>(
  definition: MaterialAssetDefinition<D>
): MaterialAsset<D> {
  if (
    definition.id.trim() === '' ||
    !Number.isInteger(definition.version) ||
    definition.version <= 0
  ) {
    throw incompatibleFromSchema(
      definition.schema,
      definition.id,
      'Invalid material asset identity.'
    );
  }
  const defaults = definition.defaults ?? createMaterialParameterBlock(definition.schema);
  const defaultState = getMaterialParameterBlockState(defaults);
  if (defaultState.schema !== definition.schema) {
    throw incompatibleFromSchema(
      definition.schema,
      definition.id,
      'Material defaults belong to another schema owner.'
    );
  }
  validateMaterialTechniques(definition.techniques, definition.schema, definition.id);
  const asset = Object.freeze({
    id: definition.id,
    version: definition.version,
    schema: definition.schema,
    techniques: freezeUnknown(cloneUnknown(definition.techniques)),
    defaults,
    renderState: freezeUnknown(cloneUnknown(definition.renderState))
  }) as MaterialAsset<D>;
  MATERIAL_ASSETS.add(asset);
  return asset;
}

export function resolveMaterialAsset<const D extends MaterialFieldDefinitions>(
  reference: MaterialAssetReference,
  asset: MaterialAsset<D>
): ResolvedMaterialAsset<D> {
  if (!MATERIAL_ASSETS.has(asset)) {
    throw incompatibleFromSchema(asset.schema, asset.id, 'Material asset was not factory-created.');
  }
  if (reference.assetId !== asset.id || reference.payloadVersion !== asset.version) {
    throw incompatibleFromSchema(
      asset.schema,
      asset.id,
      'Material asset reference does not match payload.'
    );
  }
  const resolved = Object.freeze({
    reference: Object.freeze({ ...reference }),
    asset
  });
  RESOLVED_MATERIAL_ASSETS.add(resolved);
  return resolved;
}

export function createMaterialInstance(resolved: ResolvedMaterialAsset): MaterialInstance {
  assertResolvedMaterialAsset(resolved);
  return createInstance(resolved, 0, resolved.asset.defaults, Object.freeze({}), new Map());
}

export function snapshotMaterialInstance(instance: MaterialInstance): MaterialInstanceSnapshot {
  const state = requireInstanceState(instance);
  const schema = state.resolved.asset.schema;
  const internals = getMaterialSchemaInternals(schema);
  const values = getMaterialParameterBlockState(instance.parameters).values;
  const parameters = Object.fromEntries(
    [...internals.fieldsById.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([fieldId, field]) => [fieldId, cloneMaterialValue(values[field.index])])
  ) as Record<string, MaterialValue>;
  const overrides = Object.fromEntries(
    [...state.overrides.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([fieldId, value]) => [fieldId, cloneMaterialValue(value)])
  ) as Record<string, MaterialValue>;

  return freezeUnknown({
    schemaId: schema.id,
    schemaVersion: schema.version,
    schemaFingerprint: schema.fingerprint,
    asset: { ...instance.asset },
    revision: instance.revision,
    keywords: { ...instance.keywords },
    parameters,
    overrides
  }) as MaterialInstanceSnapshot;
}

export function rehydrateMaterialInstance(
  snapshot: MaterialInstanceSnapshot,
  resolved: ResolvedMaterialAsset
): MaterialRebaseResult {
  const compatibility = validateSnapshotCompatibility(snapshot, resolved);
  if (compatibility !== null) return failure(compatibility);

  const schema = resolved.asset.schema;
  const internals = getMaterialSchemaInternals(schema);
  const fieldIds = [...internals.fieldsById.keys()];
  if (
    !isRecord(snapshot.parameters) ||
    Object.keys(snapshot.parameters).length !== fieldIds.length ||
    !fieldIds.every((fieldId) => Object.hasOwn(snapshot.parameters, fieldId))
  ) {
    return failure(incompatible(resolved, 'Material snapshot parameter fields are incomplete.'));
  }
  if (!isRecord(snapshot.overrides) || !isKeywordRecord(snapshot.keywords)) {
    return failure(incompatible(resolved, 'Material snapshot payload is malformed.'));
  }

  try {
    const changes = new Map<number, MaterialValue>();
    for (const [fieldId, field] of internals.fieldsById) {
      changes.set(field.index, snapshot.parameters[fieldId] as MaterialValue);
    }
    const parameters = commitMaterialParameterChanges(resolved.asset.defaults, changes);
    const values = getMaterialParameterBlockState(parameters).values;
    const defaults = getMaterialParameterBlockState(resolved.asset.defaults).values;
    const overrides = new Map<string, MaterialValue>();
    for (const [fieldId, value] of Object.entries(snapshot.overrides)) {
      const field = internals.fieldsById.get(fieldId);
      if (field === undefined || !materialValuesEqual(value, values[field.index])) {
        return failure(incompatible(resolved, `Invalid override field "${fieldId}".`));
      }
      const stored = values[field.index];
      if (stored !== undefined) overrides.set(fieldId, stored);
    }
    for (const [fieldId, field] of internals.fieldsById) {
      const value = values[field.index];
      if (
        !materialValuesEqual(value, defaults[field.index]) &&
        !Object.hasOwn(snapshot.overrides, fieldId)
      ) {
        return failure(incompatible(resolved, `Missing override field "${fieldId}".`));
      }
    }
    return success(
      createInstance(
        resolved,
        snapshot.revision,
        parameters,
        freezeKeywords(new Map(Object.entries(snapshot.keywords))),
        overrides
      )
    );
  } catch (error) {
    if (error instanceof MaterialDiagnosticError) return failure(error.diagnostic);
    throw error;
  }
}

export function assertResolvedMaterialAsset(resolved: ResolvedMaterialAsset): void {
  if (
    !RESOLVED_MATERIAL_ASSETS.has(resolved) ||
    !MATERIAL_ASSETS.has(resolved.asset) ||
    resolved.reference.assetId !== resolved.asset.id ||
    resolved.reference.payloadVersion !== resolved.asset.version
  ) {
    throw incompatibleFromSchema(
      resolved.asset.schema,
      resolved.asset.id,
      'Resolved material asset is inconsistent.'
    );
  }
}

function createInstance(
  resolved: ResolvedMaterialAsset,
  revision: number,
  parameters: MaterialParameterBlock,
  keywords: Readonly<Record<string, boolean | string | number>>,
  overrides: ReadonlyMap<string, MaterialValue>
): MaterialInstance {
  return new ImmutableMaterialInstance(resolved.reference, revision, parameters, keywords, {
    resolved,
    overrides: new Map(overrides)
  });
}

function validateRebase(
  current: ResolvedMaterialAsset,
  next: ResolvedMaterialAsset
): MaterialDiagnostic | null {
  try {
    assertResolvedMaterialAsset(next);
  } catch (error) {
    if (error instanceof MaterialDiagnosticError) return error.diagnostic;
    throw error;
  }
  const currentSchema = current.asset.schema;
  const nextSchema = next.asset.schema;
  return current.reference.assetId !== next.reference.assetId ||
    String(currentSchema.id) !== String(nextSchema.id) ||
    Number(currentSchema.version) !== Number(nextSchema.version) ||
    currentSchema.fingerprint !== nextSchema.fingerprint
    ? incompatible(next, 'Material asset is not rebase-compatible.')
    : null;
}

function validateSnapshotCompatibility(
  snapshot: MaterialInstanceSnapshot,
  resolved: ResolvedMaterialAsset
): MaterialDiagnostic | null {
  try {
    assertResolvedMaterialAsset(resolved);
  } catch (error) {
    if (error instanceof MaterialDiagnosticError) return error.diagnostic;
    throw error;
  }
  const schema = resolved.asset.schema;
  if (!isRecord(snapshot) || !isRecord(snapshot.asset)) {
    return incompatible(resolved, 'Material snapshot payload is malformed.');
  }
  return snapshot.asset.assetId !== resolved.reference.assetId ||
    snapshot.asset.payloadVersion !== resolved.reference.payloadVersion ||
    snapshot.schemaId !== String(schema.id) ||
    snapshot.schemaVersion !== Number(schema.version) ||
    snapshot.schemaFingerprint !== schema.fingerprint ||
    !Number.isInteger(snapshot.revision) ||
    snapshot.revision < 0
    ? incompatible(resolved, 'Material snapshot is incompatible with the resolved asset.')
    : null;
}

function freezeKeywords(
  keywords: ReadonlyMap<string, boolean | string | number>
): Readonly<Record<string, boolean | string | number>> {
  return Object.freeze(
    Object.fromEntries(
      [...keywords.entries()].sort(([left], [right]) => compareCodeUnits(left, right))
    )
  );
}

function validateKeyword(schema: MaterialSchema, name: string, value: unknown): void {
  if (
    name.trim() === '' ||
    !(
      typeof value === 'boolean' ||
      typeof value === 'string' ||
      (typeof value === 'number' && Number.isFinite(value))
    )
  ) {
    throw new MaterialDiagnosticError({
      code: 'type-mismatch',
      schemaId: schema.id,
      schemaVersion: schema.version,
      field: name,
      message: `Invalid material keyword "${name}".`
    });
  }
}

function assertActive(active: boolean): void {
  if (!active) throw new Error('Material edit draft is no longer active.');
}

function requireInstanceState(instance: MaterialInstance): MaterialInstanceState {
  const state = INSTANCE_STATES.get(instance);
  if (state === undefined) throw new Error('Unrecognized material instance.');
  return state;
}

function materialOverrideMapsEqual(
  left: ReadonlyMap<string, MaterialValue>,
  right: ReadonlyMap<string, MaterialValue>
): boolean {
  return (
    left.size === right.size &&
    [...left].every(([fieldId, value]) => materialValuesEqual(value, right.get(fieldId)))
  );
}

function success(instance: MaterialInstance): MaterialRebaseResult {
  return Object.freeze({ ok: true, instance });
}

function failure(diagnostic: MaterialDiagnostic): MaterialOperationFailure {
  return Object.freeze({ ok: false, diagnostic: Object.freeze({ ...diagnostic }) });
}

function incompatible(resolved: ResolvedMaterialAsset, message: string): MaterialDiagnostic {
  return Object.freeze({
    code: 'incompatible-asset',
    materialId: resolved.asset.id,
    schemaId: resolved.asset.schema.id,
    schemaVersion: resolved.asset.schema.version,
    message
  });
}

function incompatibleFromSchema(
  schema: MaterialSchema,
  materialId: string,
  message: string
): MaterialDiagnosticError {
  return new MaterialDiagnosticError({
    code: 'incompatible-asset',
    materialId,
    schemaId: schema.id,
    schemaVersion: schema.version,
    message
  });
}

function cloneUnknown<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneUnknown(entry)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneUnknown(entry)])
    ) as T;
  }
  return value;
}

function freezeUnknown<T>(value: T): T {
  return freezeMaterialValue(value);
}

function isKeywordRecord(value: unknown): value is Record<string, boolean | string | number> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([name, entry]) =>
        name.trim() !== '' &&
        (typeof entry === 'boolean' ||
          typeof entry === 'string' ||
          (typeof entry === 'number' && Number.isFinite(entry)))
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
