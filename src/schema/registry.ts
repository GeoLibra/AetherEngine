import type {
  FieldId,
  SchemaId,
  SchemaRegistration,
  SchemaMigrationRegistration,
  SchemaView,
  SchemaViewKind,
  SchemaVersion,
  MigrationResult,
  MigrationWarning,
  SchemaMigration,
  TypeSchema
} from './types';
import { defineResource } from '../ecs/resource';
import { cloneRecord, cloneUnknown, freezeRecord, freezeUnknown } from './migration';
import { decodeKnownPayload, encodeDecodedPayload, freezePayload } from './payload';
import { mapSchemaReferences, visitSchemaReferences } from './references';
import { freezeResolvedEntries, ReferenceResolutionError } from './reference-transaction';
import type {
  DecodedSchemaPayload,
  ReferenceResolutionIssue,
  ReferenceResolver,
  ReferenceMapper,
  ReferenceTransactionEntry,
  ReferenceVisitor,
  ResolvedReferenceEntry,
  SchemaPayload
} from './types';

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

export class SchemaRegistry {
  private readonly schemas = new Map<SchemaId, Map<SchemaVersion, RegisteredSchema>>();
  private readonly migrations = new Map<SchemaId, Map<SchemaVersion, RegisteredMigration>>();
  private nextTypeIndex = 0;

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

  get<T>(id: string, version: number): TypeSchema<T> | undefined {
    return this.getEntry(id, version)?.schema as TypeSchema<T> | undefined;
  }

  getLatest<T>(id: string): TypeSchema<T> | undefined {
    const versions = this.schemas.get(id as SchemaId);
    if (!versions || versions.size === 0) {
      return undefined;
    }
    const latestVersion = Math.max(...versions.keys());
    return versions.get(latestVersion as SchemaVersion)?.schema as TypeSchema<T> | undefined;
  }

  getTypeIndex(id: string, version: number): number | undefined {
    return this.getEntry(id, version)?.typeIndex;
  }

  getFieldIndex(id: string, version: number, field: string): number | undefined {
    return this.getEntry(id, version)?.fieldIndexes.get(field as FieldId);
  }

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

  decodePayload<T>(payload: SchemaPayload): DecodedSchemaPayload<T> {
    const frozenPayload = freezePayload(payload);
    const schema = this.get<T>(frozenPayload.schema, frozenPayload.version);
    if (!schema) {
      return Object.freeze({ kind: 'opaque', payload: frozenPayload });
    }
    return decodeKnownPayload(schema, frozenPayload);
  }

  encodePayload<T>(decoded: DecodedSchemaPayload<T>): SchemaPayload {
    return encodeDecodedPayload(decoded);
  }

  visitReferences<T>(id: string, version: number, value: T, visitor: ReferenceVisitor): void {
    const schema = this.requireSchema<T>(id, version);
    visitSchemaReferences(schema, value, visitor);
  }

  mapReferences<T>(id: string, version: number, value: T, mapper: ReferenceMapper): T {
    const schema = this.requireSchema<T>(id, version);
    return mapSchemaReferences(schema, value, mapper);
  }

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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const SchemaRegistryResource = defineResource<SchemaRegistry>('aether.schema-registry');
