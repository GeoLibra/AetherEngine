/**
 * Warning emitted during a lossy or adjusted schema migration step.
 */
export interface MigrationWarning {
  readonly code: string;
  readonly message: string;
  readonly path?: readonly (string | number)[];
}

/**
 * Result returned by a single schema migration step (N -> N+1).
 */
export interface MigrationStepResult {
  readonly value: Readonly<Record<string, unknown>>;
  readonly warnings?: readonly MigrationWarning[];
}

/**
 * Declares a single continuous migration step from version `from` to version `to` (`from + 1`).
 */
export interface SchemaMigration {
  readonly schema: string;
  readonly from: number;
  readonly to: number;
  migrate(input: Readonly<Record<string, unknown>>): MigrationStepResult;
}

/**
 * Handle returned upon registering a schema migration into `SchemaRegistry`.
 */
export interface SchemaMigrationRegistration {
  readonly migration: SchemaMigration;
  remove(): boolean;
}

/**
 * Aggregated outcome of migrating a payload across one or more continuous versions.
 */
export interface MigrationResult {
  readonly value: Readonly<Record<string, unknown>>;
  readonly warnings: readonly MigrationWarning[];
}
