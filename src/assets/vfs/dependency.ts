/** @file Pure relative dependency resolution and transport metadata redaction. */

import type { CanonicalVFSUri, VFSDependencyResolveOptions, VFSRedactedMetadata } from './types';
import { normalizeVFSUri, parseCanonicalVFSUri } from './uri';

const FORBIDDEN_ENCODED_PATTERN = /%(?:2f|5c|00)/iu;
const REPEATED_ENCODING_PATTERN = /%25(?:2e|2f|5c|00)/iu;
const SENSITIVE_PARAM_PATTERN =
  /^(?:token|key|sig|signature|auth|authorization|credential|secret|access[_-]?token|api[_-]?key|x-amz-.*|x-goog-.*)$/iu;
const SENSITIVE_HEADER_PATTERN =
  /^(?:authorization|cookie|proxy-authorization|x-api-key|x-amz-security-token|x-goog-api-key)$/iu;

/**
 * Resolves a relative asset dependency against a canonical base URI.
 * Removes `.` segments, processes `..` traversal, and strictly prevents escaping
 * above the base mount/scheme root.
 *
 * @throws If relativePath contains backslashes, NUL, encoded separators, or traverses above root.
 */
export function resolveVFSRelativeUri(
  baseUri: CanonicalVFSUri | string,
  relativePath: string,
  options?: VFSDependencyResolveOptions
): CanonicalVFSUri {
  const canonicalBase = normalizeVFSUri(baseUri);
  validateRelativePathSecurity(relativePath);

  // Check if relativePath is an absolute URI with scheme
  const schemeMatch = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/u.exec(relativePath);
  if (schemeMatch) {
    const targetUri = normalizeVFSUri(relativePath);
    if (!options?.allowCrossMount) {
      const baseParsed = parseCanonicalVFSUri(canonicalBase);
      const targetParsed = parseCanonicalVFSUri(targetUri);
      if (baseParsed.scheme !== targetParsed.scheme) {
        throw new Error(
          `Cross-mount dependency forbidden: base "${canonicalBase}" cannot reference "${targetUri}".`
        );
      }
    }
    return targetUri;
  }

  const parsedBase = parseCanonicalVFSUri(canonicalBase);
  const baseSegments = [...parsedBase.segments];
  // If base points to a file, strip the filename to get directory segments
  if (baseSegments.length > 0) {
    baseSegments.pop();
  }

  // Remove optional format-specific fragment
  const fragmentIndex = relativePath.indexOf('#');
  const pathWithoutFragment =
    fragmentIndex >= 0 ? relativePath.slice(0, fragmentIndex) : relativePath;

  const rawSegments = pathWithoutFragment.split('/');
  const stack: string[] = relativePath.startsWith('/') ? [] : [...baseSegments];

  for (const rawSegment of rawSegments) {
    if (rawSegment.length === 0 || rawSegment === '.') {
      continue;
    }
    if (rawSegment === '..') {
      if (stack.length === 0) {
        throw new Error(
          `Path traversal escaped root: "${relativePath}" traverses above "${canonicalBase}".`
        );
      }
      stack.pop();
      continue;
    }

    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw new Error(`Malformed percent encoding in segment: "${rawSegment}".`);
    }

    if (
      decoded === '.' ||
      decoded === '..' ||
      decoded.includes('/') ||
      decoded.includes('\\') ||
      decoded.includes('\0')
    ) {
      throw new Error(`Unsafe decoded path segment: "${rawSegment}".`);
    }

    stack.push(encodeURIComponent(decoded));
  }

  const encodedPath = stack.length === 0 ? '' : stack.join('/');
  const resolved = `${parsedBase.scheme}://${encodedPath}` as CanonicalVFSUri;
  return normalizeVFSUri(resolved);
}

function validateRelativePathSecurity(path: string): void {
  if (path.length === 0) {
    throw new Error('Relative dependency path must not be empty.');
  }
  if (path.includes('\\')) {
    throw new Error('Backslashes are forbidden in relative dependency paths.');
  }
  if (path.includes('\0')) {
    throw new Error('NUL characters are forbidden in relative dependency paths.');
  }
  if (FORBIDDEN_ENCODED_PATTERN.test(path)) {
    throw new Error('Percent-encoded path separators and NUL bytes are forbidden.');
  }
  if (REPEATED_ENCODING_PATTERN.test(path)) {
    throw new Error('Repeated percent-encoding traversal is forbidden.');
  }
}

/**
 * Pure function that sanitizes transport metadata for diagnostics and logging.
 * Strips sensitive authorization headers, signed query parameters, and private filesystem paths.
 */
export function redactTransportMetadata(metadata: {
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly details?: Readonly<Record<string, unknown>>;
}): VFSRedactedMetadata {
  let redactedUrl: string | undefined;
  if (metadata.url !== undefined) {
    try {
      const parsed = new URL(metadata.url);
      for (const key of Array.from(parsed.searchParams.keys())) {
        if (SENSITIVE_PARAM_PATTERN.test(key)) {
          parsed.searchParams.set(key, '[REDACTED]');
        }
      }
      redactedUrl = parsed.toString();
    } catch {
      // Non-standard or local path URL
      redactedUrl = metadata.url.replace(/[?&]([^=]+)=([^&]*)/g, (match, param) => {
        if (SENSITIVE_PARAM_PATTERN.test(param)) {
          return `${match[0]}${param}=[REDACTED]`;
        }
        return match;
      });
    }
  }

  let redactedHeaders: Record<string, string> | undefined;
  if (metadata.headers !== undefined) {
    redactedHeaders = {};
    for (const [key, value] of Object.entries(metadata.headers)) {
      if (SENSITIVE_HEADER_PATTERN.test(key)) {
        redactedHeaders[key] = '[REDACTED]';
      } else {
        redactedHeaders[key] = value;
      }
    }
  }

  let redactedDetails: Record<string, unknown> | undefined;
  if (metadata.details !== undefined) {
    redactedDetails = {};
    for (const [key, value] of Object.entries(metadata.details)) {
      if (SENSITIVE_HEADER_PATTERN.test(key) || SENSITIVE_PARAM_PATTERN.test(key)) {
        redactedDetails[key] = '[REDACTED]';
      } else if (
        typeof value === 'string' &&
        (value.startsWith('/') || /^[a-zA-Z]:\\/.test(value))
      ) {
        // Redact local filesystem path details
        redactedDetails[key] = '[REDACTED_PATH]';
      } else {
        redactedDetails[key] = value;
      }
    }
  }

  return Object.freeze({
    ...(redactedUrl !== undefined ? { url: redactedUrl } : {}),
    ...(redactedHeaders !== undefined ? { headers: Object.freeze(redactedHeaders) } : {}),
    ...(redactedDetails !== undefined ? { details: Object.freeze(redactedDetails) } : {})
  });
}
