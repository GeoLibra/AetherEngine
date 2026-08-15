import type { NativeCrashReport, NativeCrashReportInput, NativeCrashReportOptions } from './types';

const SENSITIVE_KEY = /authorization|clipboard|cookie|password|payload|secret|text|token/i;
const DEFAULT_COLLECTION_LIMIT = 32;

export function createNativeCrashReport(
  input: NativeCrashReportInput,
  options: NativeCrashReportOptions
): NativeCrashReport {
  if (!Number.isSafeInteger(options.telemetryLimit) || options.telemetryLimit < 0) {
    throw new Error('Native crash telemetry limit must be a non-negative safe integer.');
  }
  if (!Number.isSafeInteger(options.maxStringLength) || options.maxStringLength <= 0) {
    throw new Error('Native crash string limit must be a positive safe integer.');
  }
  const telemetry = input.recentTelemetry.slice(-options.telemetryLimit);
  return Object.freeze({
    jsException: sanitizeString(input.jsException, options.maxStringLength),
    nativeStack: sanitizeString(input.nativeStack, options.maxStringLength),
    device: sanitizeValue(input.device, options.maxStringLength, new WeakSet()),
    recentTelemetry: Object.freeze(
      telemetry.map((event) => sanitizeValue(event, options.maxStringLength, new WeakSet()))
    )
  });
}

function sanitizeValue(value: unknown, maxLength: number, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return sanitizeString(value, maxLength);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[REDACTED]';
  seen.add(value);
  if (Array.isArray(value)) {
    return Object.freeze(
      value.slice(0, DEFAULT_COLLECTION_LIMIT).map((item) => sanitizeValue(item, maxLength, seen))
    );
  }
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, DEFAULT_COLLECTION_LIMIT)) {
    // Sensitive structured fields are dropped before string-level path/query redaction.
    output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeValue(item, maxLength, seen);
  }
  return Object.freeze(output);
}

function sanitizeString(value: string, maxLength: number): string {
  return value
    .replace(/\/Users\/[^/\s]+\/[^\s]*/g, '[PATH_REDACTED]')
    .replace(/\/home\/[^/\s]+\/[^\s]*/g, '[PATH_REDACTED]')
    .replace(/\/(?:data\/user\/\d+|var\/mobile)\/[^\s]*/g, '[PATH_REDACTED]')
    .replace(/[A-Za-z]:\\Users\\[^\\\s]+\\[^\s]*/g, '[PATH_REDACTED]')
    .replace(/\?[^\s]*/g, '?[QUERY_REDACTED]')
    .replace(/\b(?:authorization|password|secret|token)\s*[=:]\s*[^\s,;]+/gi, '[SECRET_REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, '[SECRET_REDACTED]')
    .slice(0, maxLength);
}
