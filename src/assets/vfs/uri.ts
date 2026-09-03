import type { CanonicalVFSUri, NormalizedMountPath, VFSScheme } from './types';

const VFS_URI_PATTERN = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/u;

/** Parses and canonicalizes an asset VFS URI without applying host path semantics. */
export function normalizeVFSUri(input: string): CanonicalVFSUri {
  if (input.includes('?') || input.includes('#') || input.includes('\\')) {
    throw invalidVFSUri('unsupported URI syntax');
  }
  const match = VFS_URI_PATTERN.exec(input);
  if (!match) throw invalidVFSUri('expected scheme://path');

  const scheme = match[1]!.toLowerCase();
  const rawPath = match[2]!;
  if (rawPath.length === 0) return `${scheme}://` as CanonicalVFSUri;

  const encodedSegments = rawPath.split('/').map((rawSegment) => {
    if (rawSegment.length === 0) throw invalidVFSUri('empty path segment');
    let decoded: string;
    try {
      decoded = decodeURIComponent(rawSegment);
    } catch {
      throw invalidVFSUri('malformed percent encoding');
    }
    assertDecodedSegment(decoded);
    return encodeURIComponent(decoded);
  });
  return `${scheme}://${encodedSegments.join('/')}` as CanonicalVFSUri;
}

/** Splits an already canonical VFS URI into its scheme and decoded path segments. */
export function parseCanonicalVFSUri(uri: CanonicalVFSUri): Readonly<{
  scheme: VFSScheme;
  segments: readonly string[];
}> {
  const match = VFS_URI_PATTERN.exec(uri);
  if (!match || match[1] !== match[1]!.toLowerCase()) {
    throw invalidVFSUri('URI is not canonical');
  }
  const rawPath = match[2]!;
  const segments =
    rawPath.length === 0
      ? []
      : rawPath.split('/').map((segment) => {
          const decoded = decodeURIComponent(segment);
          assertDecodedSegment(decoded);
          return decoded;
        });
  return Object.freeze({
    scheme: match[1] as VFSScheme,
    segments: Object.freeze(segments)
  });
}

/** Creates a provider-relative absolute path from validated decoded segments. */
export function toNormalizedMountPath(segments: readonly string[]): NormalizedMountPath {
  for (const segment of segments) assertDecodedSegment(segment);
  return (segments.length === 0 ? '/' : `/${segments.join('/')}`) as NormalizedMountPath;
}

function assertDecodedSegment(segment: string): void {
  if (
    segment.length === 0 ||
    segment === '.' ||
    segment === '..' ||
    segment.includes('/') ||
    segment.includes('\\') ||
    segment.includes('\0')
  ) {
    throw invalidVFSUri('unsafe path segment');
  }
}

function invalidVFSUri(reason: string): Error {
  return new Error(`Invalid VFS URI: ${reason}.`);
}
