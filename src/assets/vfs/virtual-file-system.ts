import { VFS_FAILURE_KIND } from './constants';
import { validateExpectedIntegrity, validateVFSReadSuccess } from './integrity';
import { VFSMountTable } from './mount-table';
import { normalizeVFSUri } from './uri';
import type {
  CanonicalVFSUri,
  NormalizedMountPath,
  ResolvedVFSMount,
  VFSMount,
  VFSFailureKind,
  VFSProvider,
  VFSProviderId,
  VFSReadFailure,
  VFSReadRequest,
  VFSReadResult,
  VFSReadSuccess
} from './types';

/** Routes full reads through explicit mount policy and an owned integrity boundary. */
export class VirtualFileSystem {
  readonly #mounts = new VFSMountTable();

  /** Registers a canonical mount. @throws If its root, providers, or policy are invalid. */
  mount(mount: VFSMount): void {
    this.#mounts.register(mount);
  }

  /** Reads detached bytes; request, provider, and integrity failures are returned as values. */
  async read(input: VFSReadRequest): Promise<VFSReadResult> {
    let request: VFSReadRequest;
    let uri: CanonicalVFSUri;
    try {
      // Read each caller property exactly once before constructing the frozen snapshot.
      const uriInput = input.uri;
      const expectedLength = input.expectedLength;
      const expectedIntegrity = input.expectedIntegrity;
      const signal = input.signal;

      // Snapshot all caller-owned metadata before the first asynchronous boundary.
      request = Object.freeze({
        uri: uriInput,
        ...(expectedLength === undefined ? {} : { expectedLength }),
        ...(expectedIntegrity === undefined ? {} : { expectedIntegrity }),
        ...(signal === undefined ? {} : { signal })
      });
      uri = normalizeVFSUri(request.uri);
      if (
        request.expectedLength !== undefined &&
        (!Number.isSafeInteger(request.expectedLength) || request.expectedLength < 0)
      ) {
        throw new Error('Invalid expected byte length.');
      }
      if (request.expectedIntegrity !== undefined)
        validateExpectedIntegrity(request.expectedIntegrity);
    } catch {
      return Object.freeze({
        kind: 'invalid-request',
        code: 'vfs-invalid-request',
        message: 'Invalid VFS read request.'
      });
    }
    if (request.signal?.aborted) return failure('aborted', uri);
    let resolved: ResolvedVFSMount;
    try {
      resolved = this.#mounts.resolve(uri);
    } catch {
      return Object.freeze({
        kind: 'mount-not-found',
        code: 'vfs-mount-not-found',
        message: 'No VFS mount matches the requested URI.',
        requestedUri: uri
      });
    }
    const { mount, path } = resolved;
    if (mount.policy.consultCaches) {
      for (const cache of mount.caches) {
        const result = await attempt(cache, path, uri, request);
        if (result.kind !== 'not-found') return result;
      }
    }
    const primary = await attempt(mount.primary, path, uri, request);
    if (
      (primary.kind === 'not-found' || primary.kind === 'offline') &&
      mount.fallback &&
      mount.policy.fallbackOn.includes(primary.kind)
    ) {
      return attempt(mount.fallback, path, uri, request);
    }
    return primary;
  }
}

async function attempt(
  provider: VFSProvider,
  path: NormalizedMountPath,
  uri: CanonicalVFSUri,
  request: VFSReadRequest
): Promise<VFSReadSuccess | VFSReadFailure> {
  const providerId = provider.id;
  if (request.signal?.aborted) return failure('aborted', uri, providerId);
  try {
    const result = await provider.read(
      path,
      Object.freeze(request.signal === undefined ? {} : { signal: request.signal })
    );
    if (request.signal?.aborted) return failure('aborted', uri, providerId);
    if (result.kind !== 'success') {
      if (!Object.values(VFS_FAILURE_KIND).includes(result.kind)) {
        return failure('provider-failure', uri, providerId);
      }
      // Provider-private messages and extra fields never cross the public boundary.
      return failure(result.kind, uri, providerId);
    }
    if (
      result.providerId !== providerId ||
      !(result.bytes instanceof Uint8Array) ||
      typeof result.revision !== 'string' ||
      result.revision.length === 0 ||
      normalizeVFSUri(result.resolvedUri) !== result.resolvedUri ||
      (result.mime !== undefined && typeof result.mime !== 'string')
    ) {
      return failure('provider-failure', uri, providerId);
    }
    const validated = await validateVFSReadSuccess(uri, request, result);
    return request.signal?.aborted ? failure('aborted', uri, providerId) : validated;
  } catch {
    return request.signal?.aborted
      ? failure('aborted', uri, providerId)
      : failure('provider-failure', uri, providerId, 'vfs-provider-threw');
  }
}

function failure(
  kind: VFSFailureKind,
  requestedUri: CanonicalVFSUri,
  providerId?: VFSProviderId,
  code = `vfs-${kind}`
): VFSReadFailure {
  return Object.freeze({
    kind,
    code,
    message: `VFS read failed: ${kind}.`,
    requestedUri,
    ...(providerId === undefined ? {} : { providerId })
  });
}
