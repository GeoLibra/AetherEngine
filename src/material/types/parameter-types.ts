import type { SchemaId, SchemaVersion } from '../../schema/types';
import type { MaterialField, MaterialValue } from './schema-types';

/** Performance and allocation metrics tracked by parameter block operations. */
export interface MaterialMetrics {
  readonly blocksCloned: number;
  readonly valuesSnapshotted: number;
}

/** Immutable, version-tracked parameter block storing values for a material instance. */
export interface MaterialParameterBlock {
  readonly schemaId: SchemaId;
  readonly schemaVersion: SchemaVersion;
  readonly fingerprint: string;
  get<T extends MaterialValue>(field: MaterialField<T>): T;
  with<T extends MaterialValue>(field: MaterialField<T>, value: T): MaterialParameterBlock;
  getByName(name: string): MaterialValue;
  withName(name: string, value: MaterialValue): MaterialParameterBlock;
}

/** Transactional draft interface used during atomic material instance updates. */
export interface MaterialParameterDraft {
  set<T extends MaterialValue>(field: MaterialField<T>, value: T): void;
  setName(name: string, value: MaterialValue): void;
  setKeyword(name: string, value: boolean | string | number): void;
  removeKeyword(name: string): void;
}
