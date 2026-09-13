/**
 * Asserts that a scalar numeric parameter is finite and clamped within [0, 1].
 *
 * @throws Error when the value is NaN, infinite, or outside [0, 1].
 */
export function assertNormalizedScalar(
  value: number,
  field: string,
  prefix = 'Standard-lit'
): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${prefix} ${field} must contain finite normalized values.`);
  }
  return value;
}

/**
 * Asserts that all elements of a fixed-length numeric vector are finite and within [0, 1].
 *
 * @throws Error when length does not match or any element is NaN, infinite, or out of [0, 1].
 */
export function assertNormalizedVector<N extends number>(
  value: readonly number[],
  expectedLength: N,
  field: string,
  prefix = 'Standard-lit'
): readonly number[] {
  if (
    value.length !== expectedLength ||
    value.some((entry) => !Number.isFinite(entry) || entry < 0 || entry > 1)
  ) {
    throw new Error(`${prefix} ${field} must contain finite normalized values.`);
  }
  return Object.freeze([...value]);
}

/**
 * Asserts that a scalar numeric parameter is finite and non-negative (>= 0).
 *
 * @throws Error when the value is NaN, infinite, or negative.
 */
export function assertNonNegativeScalar(
  value: number,
  field: string,
  prefix = 'Standard-lit'
): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${prefix} ${field} must contain finite non-negative values.`);
  }
  return value;
}

/**
 * Asserts that all elements of a fixed-length numeric vector are finite and non-negative (>= 0).
 *
 * @throws Error when length does not match or any element is NaN, infinite, or negative.
 */
export function assertNonNegativeVector<N extends number>(
  value: readonly number[],
  expectedLength: N,
  field: string,
  prefix = 'Standard-lit'
): readonly number[] {
  if (
    value.length !== expectedLength ||
    value.some((entry) => !Number.isFinite(entry) || entry < 0)
  ) {
    throw new Error(`${prefix} ${field} must contain finite non-negative values.`);
  }
  return Object.freeze([...value]);
}
