import type { FieldId } from './identity';
import type { ValueType, ValueTypeDefinition } from './value-types';

/**
 * Strategy for detecting mutations or dirty states on a field.
 */
export type FieldComparison = 'identity' | 'exact' | 'epsilon' | 'shallow';

/**
 * Declares serialization visibility and persistence behavior:
 * - `save`: Persisted to disk and included in standard document saves.
 * - `runtime-only`: Ephemeral runtime state; skipped during document serialization.
 * - `editor-only`: Preserved exclusively in editor workspaces.
 */
export type FieldSerialization = 'save' | 'runtime-only' | 'editor-only';

/**
 * Policy for reference integrity and resolution:
 * - `required`: Resolution failure causes transaction/loading failure.
 * - `optional`: Nullable reference; unmapped references can be resolved to null.
 * - `soft`: Weak link; diagnostic warning on resolution failure without transaction abort.
 */
export type ReferencePolicy = 'required' | 'optional' | 'soft';

/**
 * Presentation and input constraints for editor Inspector panels.
 */
export interface EditorHint {
  readonly label?: string;
  readonly widget?: 'number' | 'slider' | 'vector' | 'rotation' | 'color' | 'asset' | 'enum';
  readonly range?: readonly [number, number];
  readonly step?: number;
  readonly group?: string;
  readonly readOnly?: boolean;
}

/**
 * Explicit replication policy for networked synchronization.
 */
export interface ReplicationPolicy {
  readonly authority: 'server' | 'owner' | 'shared';
  readonly reliability: 'reliable' | 'unreliable';
  readonly frequency?: number;
  readonly quantization?: number;
}

/**
 * Runtime schema definition for an individual field.
 */
export interface FieldSchema {
  readonly id: FieldId;
  readonly name: string;
  readonly type: ValueType;
  readonly required: boolean;
  readonly defaultValue?: unknown;
  readonly compare: FieldComparison;
  readonly serialization: FieldSerialization;
  readonly editor?: EditorHint;
  readonly replication?: ReplicationPolicy;
}

/**
 * Authoring definition format for an individual field before schema registration.
 */
export interface FieldDefinition extends Omit<FieldSchema, 'id' | 'type' | 'editor'> {
  readonly id: string;
  readonly type: ValueTypeDefinition;
  readonly editor?: EditorHint;
}
