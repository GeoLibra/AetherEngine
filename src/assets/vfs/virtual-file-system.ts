import { VFS_FAILURE_KIND } from './constants';
import { VFSInFlightCoalescer } from './coalescer';
import { validateExpectedIntegrity, validateVFSReadSuccess } from './integrity';
import { VFSMountTable } from './mount-table';
import { validateByteRange } from './range';
import { deriveVFSTransportKey } from './transport-key';
import { normalizeVFSUri } from './uri';
import type {
  ByteRange,
  CanonicalVFSUri,
  NormalizedMountPath,
  ResolvedVFSMount,
  VFSMount,
  VFSFailureKind,
  VFSPayloadLeaseResult,
  VFSPayloadRequest,
  VFSProvider,
  VFSProviderId,
  VFSRangeReadRequest,
  VFSRangeReadResult,
  VFSRangeReadSuccess,
  VFSReadFailure,
  VFSReadRequest,
  VFSReadResult,
  VFSReadSuccess,
  VFSStreamOpenResult,
  VFSStreamRequest
} from './types';

/** Routes full reads, range reads, and streams through explicit mount policy and an owned integrity boundary. */
export class VirtualFileSystem {
  readonly #mounts = new VFSMountTable();
  readonly #readCoalescer = new VFSInFlightCoalescer<VFSReadSuccess | VFSReadFailure>();
  readonly #rangeCoalescer = new VFSInFlightCoalescer<VFSRangeReadSuccess | VFSReadFailure>();

  /** Registers a canonical mount. @throws If its root, providers, or policy are invalid. */
  mount(mount: VFSMount): void {
    this.#mounts.register(mount);
  }

  /** Reads detached bytes; request, provider, and integrity failures are returned as values. */
  async read(input: VFSReadRequest): Promise<VFSReadResult> {
    let request: VFSReadRequest;
    let uri: CanonicalVFSUri;
    try {
      const uriInput = input.uri;
      const expectedLength = input.expectedLength;
      const expectedIntegrity = input.expectedIntegrity;
      const signal = input.signal;

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
      if (request.expectedIntegrity !== undefined) {
        validateExpectedIntegrity(request.expectedIntegrity);
      }
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

    const transportKey = deriveVFSTransportKey({
      providerId: mount.primary.id,
      canonicalUri: uri,
      channel: 'full',
      ...(request.expectedIntegrity === undefined ? {} : { integrity: request.expectedIntegrity })
    });

    try {
      const outcome = await this.#readCoalescer.coalesce(
        transportKey,
        request.signal,
        async (transportSignal) => {
          const transportRequest: VFSReadRequest = Object.freeze({
            ...request,
            signal: transportSignal
          });
          const primary = await attempt(mount.primary, path, uri, transportRequest);
          if (
            (primary.kind === 'not-found' || primary.kind === 'offline') &&
            mount.fallback &&
            mount.policy.fallbackOn.includes(primary.kind)
          ) {
            return attempt(mount.fallback, path, uri, transportRequest);
          }
          return primary;
        },
        (result) => {
          if (result.kind === 'success') {
            return {
              ...result,
              bytes: new Uint8Array(result.bytes)
            };
          }
          return result;
        }
      );
      return outcome;
    } catch (error) {
      if (
        request.signal?.aborted ||
        (error instanceof DOMException && error.name === 'AbortError')
      ) {
        return failure('aborted', uri, mount.primary.id);
      }
      return failure('provider-failure', uri, mount.primary.id);
    }
  }

  /** Reads a specific byte range; unsupported channel or out-of-bounds ranges are returned as typed failures. */
  async readRange(input: VFSRangeReadRequest): Promise<VFSRangeReadResult> {
    let uri: CanonicalVFSUri;
    let range: ByteRange;
    try {
      uri = normalizeVFSUri(input.uri);
      validateByteRange(input.range);
      range = Object.freeze({ offset: input.range.offset, length: input.range.length });
      if (input.expectedIntegrity !== undefined) {
        validateExpectedIntegrity(input.expectedIntegrity);
      }
    } catch {
      return Object.freeze({
        kind: 'invalid-request',
        code: 'vfs-invalid-request',
        message: 'Invalid VFS range read request.'
      });
    }

    if (input.signal?.aborted) return failure('aborted', uri);

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
    if (
      mount.primary.capabilities.range !== true ||
      typeof mount.primary.readRange !== 'function'
    ) {
      return Object.freeze({
        kind: 'unsupported-channel',
        code: 'vfs-unsupported-channel',
        message: `VFS provider "${mount.primary.id}" does not support range reads.`,
        requestedUri: uri
      });
    }

    const transportKey = deriveVFSTransportKey({
      providerId: mount.primary.id,
      canonicalUri: uri,
      channel: 'range',
      range,
      ...(input.expectedRevision === undefined ? {} : { revision: input.expectedRevision }),
      ...(input.expectedIntegrity === undefined ? {} : { integrity: input.expectedIntegrity })
    });

    try {
      const outcome = await this.#rangeCoalescer.coalesce(
        transportKey,
        input.signal,
        async (transportSignal) => {
          const providerResult = await mount.primary.readRange!(path, range, {
            signal: transportSignal
          });
          if (providerResult.kind !== 'success') {
            return failure(
              (providerResult.kind as VFSFailureKind) ?? 'provider-failure',
              uri,
              mount.primary.id,
              providerResult.code
            );
          }
          const bytes = new Uint8Array(providerResult.bytes);
          if (bytes.byteLength !== range.length) {
            return failure('integrity', uri, mount.primary.id, 'vfs-range-length-mismatch');
          }
          return {
            ...providerResult,
            bytes
          };
        },
        (result) => {
          if (result.kind === 'success') {
            return {
              ...result,
              bytes: new Uint8Array(result.bytes)
            };
          }
          return result;
        }
      );
      return outcome;
    } catch (error) {
      if (input.signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return failure('aborted', uri, mount.primary.id);
      }
      return failure('provider-failure', uri, mount.primary.id);
    }
  }

  /** Opens a single-consumer stream session over the resolved resource. */
  async openStream(input: VFSStreamRequest): Promise<VFSStreamOpenResult> {
    let uri: CanonicalVFSUri;
    try {
      uri = normalizeVFSUri(input.uri);
      if (
        input.expectedLength !== undefined &&
        (!Number.isSafeInteger(input.expectedLength) || input.expectedLength < 0)
      ) {
        throw new Error('Invalid expected length.');
      }
      if (input.expectedIntegrity !== undefined) {
        validateExpectedIntegrity(input.expectedIntegrity);
      }
    } catch {
      return Object.freeze({
        kind: 'invalid-request',
        code: 'vfs-invalid-request',
        message: 'Invalid VFS stream request.'
      });
    }

    if (input.signal?.aborted) return failure('aborted', uri);

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
    if (
      mount.primary.capabilities.stream !== true ||
      typeof mount.primary.openStream !== 'function'
    ) {
      return Object.freeze({
        kind: 'unsupported-channel',
        code: 'vfs-unsupported-channel',
        message: `VFS provider "${mount.primary.id}" does not support stream sessions.`,
        requestedUri: uri
      });
    }

    try {
      const streamOptions = Object.freeze({
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.highWaterMarkBytes === undefined
          ? {}
          : { highWaterMarkBytes: input.highWaterMarkBytes })
      });
      const result = await mount.primary.openStream(path, streamOptions);
      if (result.kind !== 'session') {
        return failure(result.kind, uri, mount.primary.id, result.code);
      }
      return result;
    } catch (error) {
      if (input.signal?.aborted) return failure('aborted', uri, mount.primary.id);
      return failure('provider-failure', uri, mount.primary.id);
    }
  }

  /** Acquires an encoded platform payload lease. */
  async acquirePayloadLease(input: VFSPayloadRequest): Promise<VFSPayloadLeaseResult> {
    let uri: CanonicalVFSUri;
    try {
      uri = normalizeVFSUri(input.uri);
    } catch {
      return Object.freeze({
        kind: 'invalid-request',
        code: 'vfs-invalid-request',
        message: 'Invalid VFS payload request.'
      });
    }

    if (input.signal?.aborted) return failure('aborted', uri);

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
    if (
      mount.primary.capabilities.payload !== true ||
      typeof mount.primary.acquirePayloadLease !== 'function'
    ) {
      return Object.freeze({
        kind: 'unsupported-channel',
        code: 'vfs-unsupported-channel',
        message: `VFS provider "${mount.primary.id}" does not support platform payload leases.`,
        requestedUri: uri
      });
    }

    const payloadOptions = Object.freeze({
      ...(input.signal === undefined ? {} : { signal: input.signal })
    });
    return mount.primary.acquirePayloadLease(path, payloadOptions);
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
      return failure(result.kind, uri, providerId, result.code);
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
