/**
 * Regular expression validating namespaced schema identifiers.
 * Must start with a lowercase letter and contain at least one namespace separator (`.`, `_`, `-`).
 * Example: `aether.transform.local`, `game_inventory_item`
 */
export const SCHEMA_ID_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/;

/**
 * Regular expression validating stable field identifiers.
 * Must begin with a letter or underscore and may contain alphanumeric characters, underscores, dots, or dashes.
 * Example: `translation`, `_private_id`, `custom.prop`
 */
export const FIELD_ID_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.-]*$/;
