/**
 * @file Foundational TypeScript type guards and object checking utilities.
 *
 * Provides pure type guard functions used across runtime, RHI, schema, material,
 * dynamic plugins, and pipeline subsystems.
 */

/**
 * Determines whether a given value is a non-null, non-array object record.
 *
 * @param value The value to test.
 * @returns `true` if the value is an object record, `false` otherwise.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Determines whether a given value is a plain JavaScript dictionary object
 * whose prototype is either `Object.prototype` or `null`.
 *
 * @param value The value to test.
 * @returns `true` if the value is a plain record object, `false` otherwise.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * Determines whether a given value is a Promise or thenable object.
 *
 * @param value The value to test.
 * @returns `true` if the value is a thenable Promise-like object, `false` otherwise.
 */
export function isPromiseLike<T = void>(value: unknown): value is PromiseLike<T> {
  return typeof value === 'object' && value !== null && 'then' in value;
}
