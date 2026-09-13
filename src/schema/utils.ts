import { isPlainRecord, isRecord } from '../core';

/**
 * Creates a deep clone of a schema-compatible value, preserving arrays, typed arrays,
 * ArrayBuffers, DataViews, and nested record dictionaries.
 *
 * @param value - The arbitrary value to clone.
 * @returns A structurally isolated deep clone of the input value.
 */
export function cloneUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(cloneUnknown);
  }
  if (value instanceof ArrayBuffer) {
    return value.slice(0);
  }
  if (ArrayBuffer.isView(value)) {
    const bytes = new Uint8Array(value.byteLength);
    bytes.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    if (value instanceof DataView) {
      return new DataView(bytes.buffer);
    }
    const Constructor = value.constructor as unknown as {
      new (buffer: ArrayBuffer): ArrayBufferView;
    };
    return new Constructor(bytes.buffer);
  }
  if (isPlainRecord(value) || isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneUnknown(entry)])
    );
  }
  return value;
}

/**
 * Recursively freezes an object and all its nested array and record children.
 *
 * @param value - The value or data structure to recursively freeze.
 * @returns The frozen value.
 */
export function freezeUnknown<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(freezeUnknown);
    return Object.freeze(value);
  }
  if (isRecord(value)) {
    Object.values(value).forEach(freezeUnknown);
    return Object.freeze(value);
  }
  return value;
}

/**
 * Clones a readonly dictionary record into an isolated mutable record.
 *
 * @param input - The record to clone.
 * @returns A mutable deep copy of the input record.
 */
export function cloneRecord(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return cloneUnknown(input) as Record<string, unknown>;
}

/**
 * Clones and deeply freezes a dictionary record.
 *
 * @param input - The record to clone and freeze.
 * @returns An immutable, frozen deep copy of the input record.
 */
export function freezeRecord(
  input: Readonly<Record<string, unknown>>
): Readonly<Record<string, unknown>> {
  return freezeUnknown(cloneRecord(input));
}
