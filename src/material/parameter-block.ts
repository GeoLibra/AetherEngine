import { MaterialDiagnosticError } from './diagnostics';
import { getMaterialFieldInternals, getMaterialSchemaInternals, isMaterialValue } from './schema';
import type {
  MaterialField,
  MaterialFieldIndex,
  MaterialMetrics,
  MaterialParameterBlock,
  MaterialSchema,
  MaterialValue
} from './types';

const BLOCK_STATES = new WeakMap<MaterialParameterBlock, MaterialParameterBlockState>();
const metrics = { blocksCloned: 0, valuesSnapshotted: 0 };

interface MaterialParameterBlockState {
  readonly schema: MaterialSchema;
  readonly values: readonly MaterialValue[];
}

class ImmutableMaterialParameterBlock implements MaterialParameterBlock {
  readonly schemaId;
  readonly schemaVersion;
  readonly fingerprint;

  constructor(
    readonly schema: MaterialSchema,
    values: readonly MaterialValue[]
  ) {
    this.schemaId = schema.id;
    this.schemaVersion = schema.version;
    this.fingerprint = schema.fingerprint;
    BLOCK_STATES.set(this, { schema, values });
    Object.freeze(this);
  }

  get<T extends MaterialValue>(field: MaterialField<T>): T {
    const state = requireBlockState(this);
    const index = validateField(state.schema, field);
    return requireValue(state.values, index) as T;
  }

  with<T extends MaterialValue>(field: MaterialField<T>, value: T): MaterialParameterBlock {
    const state = requireBlockState(this);
    const index = validateField(state.schema, field);
    return commitMaterialParameterChanges(this, new Map([[index, value]]));
  }

  getByName(name: string): MaterialValue {
    return this.get(this.schema.field(name));
  }

  withName(name: string, value: MaterialValue): MaterialParameterBlock {
    return this.with(this.schema.field(name), value);
  }
}

export function createMaterialParameterBlock(schema: MaterialSchema): MaterialParameterBlock {
  const definitions = getMaterialSchemaInternals(schema).definitions;
  return new ImmutableMaterialParameterBlock(
    schema,
    Object.freeze(definitions.map((field) => field.defaultValue)) as readonly MaterialValue[]
  );
}

export function commitMaterialParameterChanges(
  block: MaterialParameterBlock,
  changes: ReadonlyMap<number, unknown>
): MaterialParameterBlock {
  const state = requireBlockState(block);
  const definitions = getMaterialSchemaInternals(state.schema).definitions;
  const changed = new Map<number, MaterialValue>();

  for (const [index, value] of changes) {
    const definition = definitions[index];
    if (definition === undefined || !Number.isInteger(index)) {
      throw diagnostic(
        state.schema,
        'unknown-field',
        String(index),
        'Unknown material field index.'
      );
    }
    if (!isMaterialValue(value, definition.valueType)) {
      throw diagnostic(
        state.schema,
        'type-mismatch',
        definition.name,
        `Material field "${definition.name}" value does not match its declared type.`
      );
    }
    if (!materialValuesEqual(state.values[index], value)) changed.set(index, value);
  }

  if (changed.size === 0) return block;
  const values = [...state.values];
  metrics.blocksCloned += 1;
  for (const [index, value] of changed) {
    values[index] = snapshotMaterialValue(value);
  }
  return new ImmutableMaterialParameterBlock(state.schema, Object.freeze(values));
}

export function setMaterialParameterByIndex(
  block: MaterialParameterBlock,
  index: MaterialFieldIndex | number,
  value: MaterialValue
): MaterialParameterBlock {
  return commitMaterialParameterChanges(block, new Map([[index, value]]));
}

export function getMaterialParameterBlockState(
  block: MaterialParameterBlock
): MaterialParameterBlockState {
  return requireBlockState(block);
}

export function snapshotMaterialValue<T extends MaterialValue>(value: T): T {
  metrics.valuesSnapshotted += 1;
  return freezeMaterialValue(cloneMaterialValue(value));
}

export function getMaterialMetrics(): MaterialMetrics {
  return Object.freeze({ ...metrics });
}

export function resetMaterialMetrics(): void {
  metrics.blocksCloned = 0;
  metrics.valuesSnapshotted = 0;
}

export function cloneMaterialValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((entry) => cloneMaterialValue(entry)) as T;
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneMaterialValue(entry)])
    ) as T;
  }
  return value;
}

export function freezeMaterialValue<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach((entry) => freezeMaterialValue(entry));
    return Object.freeze(value) as T;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((entry) => freezeMaterialValue(entry));
    return Object.freeze(value) as T;
  }
  return value;
}

export function materialValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((entry, index) => materialValuesEqual(entry, right[index]))
    );
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) => key === rightKeys[index] && materialValuesEqual(left[key], right[key])
      )
    );
  }
  return false;
}

function validateField<T extends MaterialValue>(
  schema: MaterialSchema,
  field: MaterialField<T>
): number {
  if (String(field.schemaId) !== String(schema.id)) {
    throw diagnostic(
      schema,
      'schema-mismatch',
      field.name,
      'Material field belongs to another schema.'
    );
  }
  if (Number(field.schemaVersion) !== Number(schema.version)) {
    throw diagnostic(
      schema,
      'stale-field',
      field.name,
      'Material field uses a stale schema version.'
    );
  }
  const fieldInternals = getMaterialFieldInternals(field);
  if (fieldInternals?.fingerprint !== schema.fingerprint) {
    throw diagnostic(schema, 'stale-field', field.name, 'Material field definition has drifted.');
  }
  const schemaInternals = getMaterialSchemaInternals(schema);
  if (fieldInternals.owner !== schemaInternals.owner) {
    throw diagnostic(
      schema,
      'schema-mismatch',
      field.name,
      'Material field belongs to another owner.'
    );
  }
  return field.index;
}

function requireBlockState(block: MaterialParameterBlock): MaterialParameterBlockState {
  const state = BLOCK_STATES.get(block);
  if (state === undefined) throw new Error('Unrecognized material parameter block.');
  return state;
}

function requireValue(values: readonly MaterialValue[], index: number): MaterialValue {
  const value = values[index];
  if (value === undefined) throw new Error('Material parameter block is incomplete.');
  return value;
}

function diagnostic(
  schema: MaterialSchema,
  code: 'unknown-field' | 'type-mismatch' | 'schema-mismatch' | 'stale-field',
  field: string,
  message: string
): MaterialDiagnosticError {
  return new MaterialDiagnosticError({
    code,
    schemaId: schema.id,
    schemaVersion: schema.version,
    field,
    message
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
