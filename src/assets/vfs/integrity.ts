import type { CanonicalVFSUri, VFSReadFailure, VFSReadRequest, VFSReadSuccess } from './types';

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const HEX = Array.from({ length: 256 }, (_, value) => value.toString(16).padStart(2, '0'));

/** Validates and canonicalizes a SHA-256 integrity expectation. */
export function validateExpectedIntegrity(value: string): string {
  const digest = value.startsWith('sha256:') ? value.slice(7) : value;
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error('VFS integrity expectation must be a lowercase SHA-256 digest.');
  }
  return digest;
}

/** Copies and validates a provider success before it crosses the VFS boundary. */
export async function validateVFSReadSuccess(
  requestedUri: CanonicalVFSUri,
  request: VFSReadRequest,
  result: VFSReadSuccess
): Promise<VFSReadSuccess | VFSReadFailure> {
  const bytes = result.bytes.slice();
  if (
    result.contentLength !== bytes.byteLength ||
    (request.expectedLength !== undefined && request.expectedLength !== bytes.byteLength)
  ) {
    return integrityFailure(requestedUri, result);
  }

  let expected: string | undefined;
  let declared: string | undefined;
  try {
    expected =
      request.expectedIntegrity === undefined
        ? undefined
        : validateExpectedIntegrity(request.expectedIntegrity);
    declared =
      result.integrity === undefined ? undefined : validateExpectedIntegrity(result.integrity);
  } catch {
    return integrityFailure(requestedUri, result);
  }
  if (expected !== undefined || declared !== undefined) {
    const actual = await sha256(bytes);
    if (
      (expected !== undefined && expected !== actual) ||
      (declared !== undefined && declared !== actual)
    ) {
      return integrityFailure(requestedUri, result);
    }
  }

  return Object.freeze({
    ...result,
    bytes,
    ...(declared === undefined ? {} : { integrity: declared })
  });
}

function integrityFailure(requestedUri: CanonicalVFSUri, result: VFSReadSuccess): VFSReadFailure {
  return Object.freeze({
    kind: 'integrity',
    code: 'vfs-integrity-mismatch',
    message: 'VFS read failed integrity validation.',
    requestedUri,
    providerId: result.providerId
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer)
  );
  let encoded = '';
  for (const byte of digest) encoded += HEX[byte]!;
  return encoded;
}
