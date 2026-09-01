import type { FieldId, SchemaId } from './identity';
import type { ReferencePolicy } from './fields';

/**
 * Declares a reference to an entity or asset within a document or scene.
 */
export type DocumentReference =
  | { readonly kind: 'entity'; readonly id: string }
  | { readonly kind: 'asset'; readonly id: string; readonly expectedType?: string };

/**
 * Segment in a nested reference navigation path.
 */
export type ReferencePathSegment =
  | { readonly kind: 'field'; readonly id: FieldId }
  | { readonly kind: 'array'; readonly index: number }
  | { readonly kind: 'map'; readonly key: string };

/**
 * Context provided during reference traversal or mapping.
 */
export interface ReferenceVisit {
  readonly schema: SchemaId;
  readonly path: readonly ReferencePathSegment[];
  readonly policy: ReferencePolicy;
  readonly reference: DocumentReference;
  readonly expectedType?: string;
}

/**
 * Callback function for inspecting references in a schema-typed value.
 */
export type ReferenceVisitor = (visit: ReferenceVisit) => void;

/**
 * Callback function for transforming or remapping references in a schema-typed value.
 * Returning `null` unsets optional references.
 */
export type ReferenceMapper = (visit: ReferenceVisit) => DocumentReference | null;

/**
 * Entry supplied to a reference resolution transaction.
 */
export interface ReferenceTransactionEntry<T = unknown> {
  readonly key: string;
  readonly schema: string;
  readonly version: number;
  readonly value: T;
}

/**
 * Fully validated and remapped entry produced by a reference resolution transaction.
 */
export interface ResolvedReferenceEntry<T = unknown> extends ReferenceTransactionEntry<T> {}

/**
 * Diagnostic issue recorded when a required reference fails resolution.
 */
export interface ReferenceResolutionIssue {
  readonly key: string;
  readonly schema: SchemaId;
  readonly path: readonly ReferencePathSegment[];
  readonly reference: DocumentReference;
  readonly message: string;
}

/**
 * Resolver callback used by `SchemaRegistry.resolveReferenceTransaction()`.
 */
export type ReferenceResolver = (visit: ReferenceVisit) => DocumentReference | null;
