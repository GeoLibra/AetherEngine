/**
 * @file Deterministic string and identifier comparison utilities.
 *
 * Provides pure, allocation-free, locale-independent comparison functions
 * for deterministic sorting of dictionary keys, shader layouts, pipeline hashes,
 * and runtime entities across all platforms and environments.
 */

/**
 * Compares two strings based on their UTF-16 code units.
 *
 * Provides a deterministic, locale-independent total ordering equivalent to the
 * standard `<` and `>` operators. Used throughout the engine for canonical sorting
 * (e.g. dictionary keys, layout bindings, pipeline identifiers) without the
 * performance overhead and locale variance of `String.prototype.localeCompare`.
 *
 * @param left The left-hand string to compare.
 * @param right The right-hand string to compare.
 * @returns `-1` if `left < right`, `1` if `left > right`, or `0` if `left === right`.
 */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
