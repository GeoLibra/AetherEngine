/**
 * @file Deterministic hashing utilities and canonical JSON serialization.
 *
 * Provides pure, zero-dependency hashing algorithms (32-bit and 64-bit FNV-1a)
 * and order-insensitive canonical JSON serialization for stable snapshots,
 * caching keys, variant fingerprinting, and pipeline resolver lookup.
 */

/**
 * Deterministically serializes a JavaScript value into a canonical JSON string.
 *
 * Object keys are sorted lexicographically at every nested level so that
 * semantically identical objects with different property insertion orders produce
 * identical JSON strings.
 *
 * @param value The value to serialize.
 * @returns A deterministic canonical JSON string.
 */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(',')}}`;
}

/**
 * Computes a 64-bit FNV-1a non-cryptographic hash of a UTF-16 string.
 *
 * Uses the standard 64-bit FNV offset basis (0xcbf29ce484222325) and prime (0x100000001b3).
 *
 * @param text The input string to hash.
 * @returns A 16-character lowercase hexadecimal string representing the 64-bit unsigned hash.
 */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= BigInt(text.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Computes a 32-bit FNV-1a non-cryptographic hash of a UTF-16 string as an unsigned 32-bit integer.
 *
 * Uses the standard 32-bit FNV offset basis (0x811c9dc5) and prime (0x01000193) with zero allocations.
 *
 * @param text The input string to hash.
 * @returns An unsigned 32-bit integer (0 to 4294967295).
 */
export function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Computes a 32-bit FNV-1a hash of a UTF-16 string and formats it as an 8-character hex string.
 *
 * @param text The input string to hash.
 * @returns An 8-character lowercase hexadecimal string.
 */
export function fnv1a32Hex(text: string): string {
  return fnv1a32(text).toString(16).padStart(8, '0');
}

/**
 * Computes a stable, deterministic 64-bit FNV-1a hash for any JavaScript value.
 *
 * If the value is a string, it is hashed directly; otherwise, it is first serialized
 * via {@link canonicalStringify}.
 *
 * @param value The value to compute a stable hash for.
 * @returns A 16-character lowercase hexadecimal string.
 */
export function stableHash(value: unknown): string {
  const text = typeof value === 'string' ? value : canonicalStringify(value);
  return fnv1a64(text);
}
