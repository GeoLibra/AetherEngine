import type {
  DecodedSchemaPayload,
  FieldId,
  MigrationResult,
  MigrationWarning,
  ReferenceMapper,
  ReferenceResolutionIssue,
  ReferenceResolver,
  ReferenceTransactionEntry,
  ReferenceVisitor,
  ResolvedReferenceEntry,
  SchemaId,
  SchemaMigration,
  SchemaMigrationRegistration,
  SchemaPayload,
  SchemaRegistration,
  SchemaVersion,
  SchemaView,
  SchemaViewKind,
  TypeSchema
} from './types';
import { defineResource } from '../ecs/resource';
import { cloneRecord, cloneUnknown, freezeRecord, freezeUnknown, isRecord } from './utils';
import { decodeKnownPayload, encodeDecodedPayload, freezePayload } from './payload';
import { mapSchemaReferences, visitSchemaReferences } from './references';
import { freezeResolvedEntries, ReferenceResolutionError } from './reference-transaction';

interface RegisteredSchema {
  readonly schema: TypeSchema<unknown>;
  readonly typeIndex: number;
  readonly fieldIndexes: ReadonlyMap<FieldId, number>;
  registrations: number;
}

interface RegisteredMigration {
  readonly migration: SchemaMigration;
  registrations: number;
}

/**
 * Central runtime registry for schema contracts, versions, continuous migrations, and derived views.
 *
 * Responsibilities:
 * - SchemaId uniqueness and multi-version registration with reference counted ownership handles.
 * - Allocation of runtime numeric type indexes and field indexes for fast-path engine operations.
 * - Continuous N -> N+1 version migration execution with lossy warnings tracking.
 * - Lossless round-trip payload decoding and encoding preserving unknown plugin extensions.
 * - Document/Entity reference visiting, remapping, and transaction-scoped resolution.
 * - Projection of specialized consumer views (serialization, editor Inspector hints, networked replication).
 */
export class SchemaRegistry {
  private readonly schemas = new Map<SchemaId, Map<SchemaVersion, RegisteredSchema>>();
  private readonly migrations = new Map<SchemaId, Map<SchemaVersion, RegisteredMigration>>();
  private nextTypeIndex = 0;

  /**
   * Registers an immutable `TypeSchema<T>` into the registry.
   *
   * @typeParam T - The runtime data type represented by the schema.
   * @param schema - The schema contract to register.
   * @returns An ownership handle with a `remove()` method to release this registration.
   * @throws {Error} If a schema with the same ID and version is already registered with a different contract.
   */
  register<T>(schema: TypeSchema<T>): SchemaRegistration<T> {
    let versions = this.schemas.get(schema.id);
    if (!versions) {
      versions = new Map();
      this.schemas.set(schema.id, versions);
    }

    const existing = versions.get(schema.version);
    if (existing) {
      if (existing.schema !== schema) {
        throw new Error(
          `Schema "${schema.id}" version ${schema.version} is already registered with a different contract.`
        );
      }
      existing.registrations++;
      return this.createSchemaRegistration(schema, existing.typeIndex);
    }

    const typeIndex = this.nextTypeIndex++;
    const fieldIndexes = new Map<FieldId, number>();
    schema.fields.forEach((field, index) => fieldIndexes.set(field.id, index));
    versions.set(schema.version, {
      schema: schema as TypeSchema<unknown>,
      typeIndex,
      fieldIndexes,
      registrations: 1
    });
    return this.createSchemaRegistration(schema, typeIndex);
  }

  /**
   * Retrieves a registered schema by its stable ID and version.
   *
   * @typeParam T - The expected runtime type.
   * @param id - The stable namespaced schema identifier.
   * @param version - The specific integer schema version.
   * @returns The registered `TypeSchema<T>` or undefined if not found.
   */
  get<T>(id: string, version: number): TypeSchema<T> | undefined {
    return this.getEntry(id, version)?.schema as TypeSchema<T> | undefined;
  }

  /**
   * Retrieves the highest version registered for a given schema ID.
   *
   * @typeParam T - The expected runtime type.
   * @param id - The stable namespaced schema identifier.
   * @returns The latest `TypeSchema<T>` or undefined if the schema is not registered.
   */
  getLatest<T>(id: string): TypeSchema<T> | undefined {
    const versions = this.schemas.get(id as SchemaId);
    if (!versions || versions.size === 0) {
      return undefined;
    }
    const latestVersion = Math.max(...versions.keys());
    return versions.get(latestVersion as SchemaVersion)?.schema as TypeSchema<T> | undefined;
  }

  /**
   * Returns the runtime numeric type index assigned to a registered schema.
   *
   * @param id - The schema identifier.
   * @param version - The schema version.
   * @returns The numeric type index or undefined if not registered.
   */
  getTypeIndex(id: string, version: number): number | undefined {
    return this.getEntry(id, version)?.typeIndex;
  }

  /**
   * Returns the zero-based field index for a specific stable field ID within a registered schema.
   *
   * @param id - The schema identifier.
   * @param version - The schema version.
   * @param field - The stable field ID.
   * @returns The field index or undefined if not found.
   */
  getFieldIndex(id: string, version: number, field: string): number | undefined {
    return this.getEntry(id, version)?.fieldIndexes.get(field as FieldId);
  }

  /**
   * Derives a consumer-specific `SchemaView<T>` (e.g. serialization-only fields, editor hints, or replication).
   *
   * @typeParam T - The runtime data type.
   * @param id - The schema identifier.
   * @param version - The schema version.
   * @param kind - The desired view projection (`serialization`, `editor`, or `replication`).
   * @returns The derived `SchemaView<T>` or undefined if the schema is not registered.
   */
  getView<T>(id: string, version: number, kind: SchemaViewKind): SchemaView<T> | undefined {
    const entry = this.getEntry(id, version);
    if (!entry) {
      return undefined;
    }
    const fields = entry.schema.fields.filter((field) => {
      switch (kind) {
        case 'serialization':
          return field.serialization === 'save';
        case 'replication':
          return field.replication !== undefined;
        case 'editor':
          return true;
      }
    });
    return Object.freeze({
      kind,
      schema: entry.schema as TypeSchema<T>,
      typeIndex: entry.typeIndex,
      fields: Object.freeze(fields)
    });
  }

  /**
   * Registers a continuous single-step version migration (`from -> to`, where `to === from + 1`).
   *
   * @param migration - The migration step definition.
   * @returns An ownership handle with a `remove()` method to release this migration step.
   * @throws {Error} If version numbers are invalid, non-continuous, or referenced schema versions are not registered.
   */
  registerMigration(migration: SchemaMigration): SchemaMigrationRegistration {
    if (
      !Number.isInteger(migration.from) ||
      !Number.isInteger(migration.to) ||
      migration.from <= 0 ||
      migration.to !== migration.from + 1
    ) {
      throw new Error('Schema migrations must form continuous N -> N+1 steps.');
    }
    if (!this.getEntry(migration.schema, migration.from)) {
      throw new Error(
        `Cannot register migration for unknown schema "${migration.schema}" version ${migration.from}.`
      );
    }
    if (!this.getEntry(migration.schema, migration.to)) {
      throw new Error(
        `Cannot register migration for unknown schema "${migration.schema}" version ${migration.to}.`
      );
    }

    const id = migration.schema as SchemaId;
    let steps = this.migrations.get(id);
    if (!steps) {
      steps = new Map();
      this.migrations.set(id, steps);
    }
    const existing = steps.get(migration.from as SchemaVersion);
    if (existing && existing.migration !== migration) {
      throw new Error(
        `Migration for schema "${migration.schema}" from version ${migration.from} is already registered.`
      );
    }
    if (existing) {
      existing.registrations++;
    } else {
      steps.set(migration.from as SchemaVersion, { migration, registrations: 1 });
    }
    return this.createMigrationRegistration(migration);
  }

  /**
   * Migrates a raw payload record from a source version to a target version along a continuous migration chain.
   *
   * @param id - The schema identifier.
   * @param from - The initial version number.
   * @param to - The target version number (must be >= from).
   * @param input - The raw input record to migrate.
   * @returns The migrated record alongside any lossy migration warnings.
   * @throws {Error} If downgrade is attempted, schemas are unknown, or any step in the migration chain is missing.
   */
  migrate(
    id: string,
    from: number,
    to: number,
    input: Readonly<Record<string, unknown>>
  ): MigrationResult {
    if (from > to) {
      throw new Error('Schema downgrade migrations are not supported.');
    }
    if (!this.getEntry(id, from) || !this.getEntry(id, to)) {
      throw new Error(`Cannot migrate unknown schema "${id}" from ${from} to ${to}.`);
    }

    let value = cloneRecord(input);
    const warnings: MigrationWarning[] = [];
    for (let version = from; version < to; version++) {
      const registeredMigration = this.migrations
        .get(id as SchemaId)
        ?.get(version as SchemaVersion);
      if (!registeredMigration) {
        throw new Error(
          `No continuous migration path for schema "${id}" from ${version} to ${version + 1}.`
        );
      }
      const migration = registeredMigration.migration;
      const result = migration.migrate(freezeRecord(value));
      if (!isRecord(result.value)) {
        throw new Error(
          `Migration for schema "${id}" from ${version} returned a non-record value.`
        );
      }
      value = cloneRecord(result.value);
      warnings.push(...(result.warnings ?? []));
    }
    return Object.freeze({
      value: freezeRecord(value),
      warnings: freezeUnknown(cloneUnknown(warnings)) as readonly MigrationWarning[]
    });
  }

  /**
   * Decodes a serialized `SchemaPayload`. If the schema is registered, decodes it into a typed
   * `KnownSchemaPayload<T>`; otherwise, preserves it as an `OpaqueSchemaPayload`.
   *
   * @typeParam T - The expected value type.
   * @param payload - The raw payload to decode.
   * @returns The decoded known or opaque payload.
   */
  decodePayload<T>(payload: SchemaPayload): DecodedSchemaPayload<T> {
    const frozenPayload = freezePayload(payload);
    const schema = this.get<T>(frozenPayload.schema, frozenPayload.version);
    if (!schema) {
      return Object.freeze({ kind: 'opaque', payload: frozenPayload });
    }
    return decodeKnownPayload(schema, frozenPayload);
  }

  /**
   * Encodes a `DecodedSchemaPayload` into a serialized `SchemaPayload`.
   *
   * @typeParam T - The value type.
   * @param decoded - The decoded payload.
   * @returns A serialized raw schema payload.
   */
  encodePayload<T>(decoded: DecodedSchemaPayload<T>): SchemaPayload {
    return encodeDecodedPayload(decoded);
  }

  /**
   * Traverses all entity and asset references in a schema-typed instance.
   *
   * @typeParam T - The typed schema value.
   * @param id - The schema identifier.
   * @param version - The schema version.
   * @param value - The value instance to inspect.
   * @param visitor - The callback invoked for each detected reference.
   * @throws {Error} If the schema is not registered.
   */
  visitReferences<T>(id: string, version: number, value: T, visitor: ReferenceVisitor): void {
    const schema = this.requireSchema<T>(id, version);
    visitSchemaReferences(schema, value, visitor);
  }

  /**
   * Remaps all entity and asset references in a schema-typed instance.
   *
   * @typeParam T - The typed schema value.
   * @param id - The schema identifier.
   * @param version - The schema version.
   * @param value - The value instance to remap.
   * @param mapper - The transformation callback invoked for each reference.
   * @returns A cloned copy with remapped references.
   * @throws {Error} If the schema is not registered or a required reference is cleared.
   */
  mapReferences<T>(id: string, version: number, value: T, mapper: ReferenceMapper): T {
    const schema = this.requireSchema<T>(id, version);
    return mapSchemaReferences(schema, value, mapper);
  }

  /**
   * Resolves references across an entire batch of transaction entries in an all-or-nothing operation.
   *
   * @param entries - The transaction entries to resolve.
   * @param resolver - The resolver callback providing target references.
   * @returns An immutable array of resolved and remapped entries.
   * @throws {ReferenceResolutionError} If any required references fail resolution.
   * @throws {Error} If entry keys are empty or duplicated, or schema validation fails.
   */
  resolveReferenceTransaction(
    entries: readonly ReferenceTransactionEntry[],
    resolver: ReferenceResolver
  ): readonly ResolvedReferenceEntry[] {
    const keys = new Set<string>();
    const issues: ReferenceResolutionIssue[] = [];
    const resolved = entries.map((entry): ResolvedReferenceEntry => {
      if (entry.key.trim() === '' || keys.has(entry.key)) {
        throw new Error(
          entry.key.trim() === ''
            ? 'Reference transaction entry key must not be empty.'
            : `Reference transaction contains duplicate key "${entry.key}".`
        );
      }
      keys.add(entry.key);
      const schema = this.requireSchema<unknown>(entry.schema, entry.version);
      const input = schema.validate(freezeUnknown(cloneUnknown(entry.value)));
      if (!input.ok) {
        throw new Error(
          `Reference transaction entry "${entry.key}" failed schema validation: ${input.issues
            .map((issue) => issue.message)
            .join('; ')}`
        );
      }
      const value = mapSchemaReferences(schema, input.value, (visit) => {
        const mapped = resolver(visit);
        if (mapped === null && visit.policy === 'required') {
          issues.push(
            Object.freeze({
              key: entry.key,
              schema: visit.schema,
              path: visit.path,
              reference: visit.reference,
              message: `Required reference "${visit.reference.id}" could not be resolved.`
            })
          );
          // Continue visiting so diagnostics report the complete failed transaction.
          return visit.reference;
        }
        return mapped;
      });
      const output = schema.validate(freezeUnknown(cloneUnknown(value)));
      if (!output.ok) {
        throw new Error(
          `Reference transaction entry "${entry.key}" failed mapped schema validation: ${output.issues
            .map((issue) => issue.message)
            .join('; ')}`
        );
      }
      return {
        key: entry.key,
        schema: entry.schema,
        version: entry.version,
        value: output.value
      };
    });
    if (issues.length > 0) {
      throw new ReferenceResolutionError(Object.freeze(issues));
    }
    return freezeResolvedEntries(resolved);
  }

  /**
   * Deeply clones a value conforming to a registered schema.
   *
   * @typeParam T - The typed schema value.
   * @param id - The schema identifier.
   * @param version - The schema version.
   * @param value - The value to clone.
   * @returns A deep clone of the value.
   * @throws {Error} If the schema is not registered.
   */
  clone<T>(id: string, version: number, value: T): T {
    this.requireSchema<T>(id, version);
    return cloneUnknown(value) as T;
  }

  private getEntry(id: string, version: number): RegisteredSchema | undefined {
    return this.schemas.get(id as SchemaId)?.get(version as SchemaVersion);
  }

  private requireSchema<T>(id: string, version: number): TypeSchema<T> {
    const schema = this.get<T>(id, version);
    if (!schema) {
      throw new Error(`Unknown schema "${id}" version ${version}.`);
    }
    return schema;
  }

  private createSchemaRegistration<T>(
    schema: TypeSchema<T>,
    typeIndex: number
  ): SchemaRegistration<T> {
    let active = true;
    return Object.freeze({
      schema,
      typeIndex,
      remove: (): boolean => {
        if (!active) {
          return false;
        }
        const entry = this.getEntry(schema.id, schema.version);
        if (!entry || entry.schema !== schema || entry.registrations <= 0) {
          return false;
        }
        entry.registrations--;
        active = false;
        this.removeSchemaIfUnused(schema.id, schema.version);
        return true;
      }
    });
  }

  private createMigrationRegistration(migration: SchemaMigration): SchemaMigrationRegistration {
    let active = true;
    return Object.freeze({
      migration,
      remove: (): boolean => {
        if (!active) {
          return false;
        }
        const id = migration.schema as SchemaId;
        const from = migration.from as SchemaVersion;
        const steps = this.migrations.get(id);
        const registered = steps?.get(from);
        if (!registered || registered.migration !== migration || registered.registrations <= 0) {
          return false;
        }
        registered.registrations--;
        active = false;
        if (registered.registrations === 0) {
          steps?.delete(from);
          if (steps?.size === 0) {
            this.migrations.delete(id);
          }
          this.removeSchemaIfUnused(id, migration.from as SchemaVersion);
          this.removeSchemaIfUnused(id, migration.to as SchemaVersion);
        }
        return true;
      }
    });
  }

  private removeSchemaIfUnused(id: SchemaId, version: SchemaVersion): void {
    const versions = this.schemas.get(id);
    const entry = versions?.get(version);
    if (!entry || entry.registrations > 0 || this.hasMigrationReference(id, version)) {
      return;
    }
    versions?.delete(version);
    if (versions?.size === 0) {
      this.schemas.delete(id);
    }
  }

  private hasMigrationReference(id: SchemaId, version: SchemaVersion): boolean {
    for (const registered of this.migrations.get(id)?.values() ?? []) {
      const migration = registered.migration;
      if (migration.from === version || migration.to === version) {
        return true;
      }
    }
    return false;
  }
}

/**
 * ECS ResourceToken providing access to the engine's central `SchemaRegistry`.
 */
export const SchemaRegistryResource = defineResource<SchemaRegistry>('aether.schema-registry');
