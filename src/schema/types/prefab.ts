import type { FieldId, SchemaId } from './identity';

/**
 * Segment within a stable Prefab override path.
 * Disallows unstable array indices, enforcing stable element keys or field IDs.
 */
export type PrefabPathSegment =
  | { readonly kind: 'field'; readonly id: FieldId }
  | { readonly kind: 'element'; readonly key: string }
  | { readonly kind: 'map'; readonly key: string };

/**
 * Compiled immutable Prefab override path for targeted property patching.
 */
export interface PrefabOverridePath {
  readonly localEntityId: string;
  readonly schema: SchemaId;
  readonly segments: readonly PrefabPathSegment[];
}

/**
 * Authoring definition format for creating a `PrefabOverridePath`.
 */
export interface PrefabOverridePathDefinition {
  readonly localEntityId: string;
  readonly schema: string;
  readonly segments: readonly (
    | { readonly kind: 'field'; readonly id: string }
    | { readonly kind: 'element'; readonly key: string }
    | { readonly kind: 'map'; readonly key: string }
  )[];
}
