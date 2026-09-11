import type { ByteRange } from './types';

const CONTENT_RANGE_PATTERN = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/iu;

/**
 * Validates a ByteRange object.
 * @throws If offset is not a non-negative safe integer or length is not a positive safe integer.
 */
export function validateByteRange(range: ByteRange): void {
  if (
    !Number.isSafeInteger(range.offset) ||
    range.offset < 0 ||
    !Number.isSafeInteger(range.length) ||
    range.length <= 0
  ) {
    throw new Error(
      `Invalid byte range: offset (${range.offset}) must be non-negative and length (${range.length}) must be positive.`
    );
  }
}

/**
 * Formats a ByteRange as an HTTP Range header value.
 * Range: bytes=<offset>-<offset + length - 1>
 */
export function formatHttpRangeHeader(range: ByteRange): string {
  validateByteRange(range);
  const endInclusive = range.offset + range.length - 1;
  return `bytes=${range.offset}-${endInclusive}`;
}

/**
 * Parses and validates a standard Content-Range response header.
 * Expected format: `bytes <start>-<end>/<total>` or `bytes <start>-<end>/*`.
 */
export function parseContentRangeHeader(
  headerValue: string,
  expectedRange?: ByteRange
): {
  readonly start: number;
  readonly endInclusive: number;
  readonly byteLength: number;
  readonly totalLength: number | null;
} {
  const match = CONTENT_RANGE_PATTERN.exec(headerValue.trim());
  if (!match) {
    throw new Error(`Invalid Content-Range header: "${headerValue}".`);
  }

  const start = Number(match[1]);
  const endInclusive = Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);

  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(endInclusive) || start > endInclusive) {
    throw new Error(`Malformed Content-Range values: ${start}-${endInclusive}.`);
  }

  const byteLength = endInclusive - start + 1;
  if (total !== null && (total <= endInclusive || !Number.isSafeInteger(total))) {
    throw new Error(`Inconsistent Content-Range total: ${total} for range end ${endInclusive}.`);
  }

  if (expectedRange !== undefined) {
    if (start !== expectedRange.offset) {
      throw new Error(
        `Content-Range offset mismatch: expected ${expectedRange.offset}, received ${start}.`
      );
    }
    if (byteLength !== expectedRange.length) {
      throw new Error(
        `Content-Range length mismatch: expected ${expectedRange.length}, received ${byteLength}.`
      );
    }
  }

  return Object.freeze({
    start,
    endInclusive,
    byteLength,
    totalLength: total
  });
}

/**
 * Extracts a detached Uint8Array copy for a requested range from full-body bytes.
 */
export function sliceRangeBytes(bytes: Uint8Array, range: ByteRange): Uint8Array {
  validateByteRange(range);
  const start = range.offset;
  const end = range.offset + range.length;
  if (start > bytes.byteLength || end > bytes.byteLength) {
    throw new Error(`Range [${start}, ${end}) exceeds source byte length (${bytes.byteLength}).`);
  }
  // Construct a brand new detached Uint8Array to prevent shared buffer retainment
  return new Uint8Array(bytes.subarray(start, end));
}
