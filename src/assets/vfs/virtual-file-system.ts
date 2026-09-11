import { VFS_FAILURE_KIND } from './constants';
import { VFSInFlightCoalescer } from './coalescer';
import { IncrementalSha256 } from './incremental-sha256';
import {
  checkIntegrityExpectations,
  validateExpectedIntegrity,
  validateVFSReadSuccess
} from './integrity';
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
  VFSPayloadLease,
  VFSPayloadLeaseResult,
  VFSPayloadRequest,
  VFSProvider,
  VFSProviderId,
  VFSProviderRangeReadOptions,
  VFSRangeReadRequest,
  VFSRangeReadResult,
  VFSRangeReadSuccess,
  VFSReadFailure,
  VFSReadRequest,
  VFSReadResult,
  VFSReadSuccess,
  VFSStreamOpenResult,
  VFSStreamRequest,
  VFSStreamSession,
  VFSVerification,
  VFSBoundaryFailure
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
    const rawUri = input.uri;
    const expectedLength = input.expectedLength;
    const expectedIntegrity = input.expectedIntegrity;
    const signal = input.signal;

    let uri: CanonicalVFSUri;
    try {
      uri = validateRequestInput(rawUri, expectedLength, expectedIntegrity);
    } catch {
      return invalidRequest('Invalid VFS read request.');
    }
    const request = Object.freeze({
      uri: rawUri,
      ...(expectedLength !== undefined && { expectedLength }),
      ...(expectedIntegrity !== undefined && { expectedIntegrity }),
      ...(signal !== undefined && { signal })
    });

    if (request.signal?.aborted) return failure('aborted', uri);
    const resolved = this.#resolveMount(uri);
    if ('kind' in resolved) return resolved;

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
      ...(request.expectedLength === undefined ? {} : { expectedLength: request.expectedLength }),
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
        (result) =>
          result.kind === 'success' ? { ...result, bytes: new Uint8Array(result.bytes) } : result
      );
      if (outcome.kind === 'success') {
        return validateVFSReadSuccess(uri, request, outcome);
      }
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
    const rawUri = input.uri;
    const rawRange = input.range;
    const expectedRevision = input.expectedRevision;
    const expectedIntegrity = input.expectedIntegrity;
    const signal = input.signal;
    const allowFullBodyFallback = input.allowFullBodyFallback;
    const maxBodyBytes = input.maxBodyBytes;

    let uri: CanonicalVFSUri;
    let range: ByteRange;
    try {
      uri = validateRequestInput(rawUri, undefined, expectedIntegrity);
      validateByteRange(rawRange);
      range = Object.freeze({ offset: rawRange.offset, length: rawRange.length });
    } catch {
      return invalidRequest('Invalid VFS range read request.');
    }

    if (signal?.aborted) return failure('aborted', uri);
    const resolved = this.#resolveMount(uri);
    if ('kind' in resolved) return resolved;

    const { mount, path } = resolved;
    if (
      mount.primary.capabilities.range !== true ||
      typeof mount.primary.readRange !== 'function'
    ) {
      return unsupportedChannel(uri, mount.primary.id, 'range reads');
    }

    const transportKey = deriveVFSTransportKey({
      providerId: mount.primary.id,
      canonicalUri: uri,
      channel: 'range',
      range,
      ...(expectedRevision === undefined ? {} : { revision: expectedRevision }),
      ...(expectedIntegrity === undefined ? {} : { integrity: expectedIntegrity })
    });

    try {
      const outcome = await this.#rangeCoalescer.coalesce(
        transportKey,
        signal,
        async (transportSignal) => {
          const rangeOptions: VFSProviderRangeReadOptions = Object.freeze({
            signal: transportSignal,
            ...(expectedRevision !== undefined && { expectedRevision }),
            ...(expectedIntegrity !== undefined && { expectedIntegrity }),
            ...(allowFullBodyFallback !== undefined && { allowFullBodyFallback }),
            ...(maxBodyBytes !== undefined && { maxBodyBytes })
          });
          const providerResult = await mount.primary.readRange!(path, range, rangeOptions);
          if (providerResult.kind !== 'success') {
            return failure(
              (providerResult.kind as VFSFailureKind) ?? 'provider-failure',
              uri,
              mount.primary.id,
              providerResult.code
            );
          }
          if (
            providerResult.providerId !== mount.primary.id ||
            providerResult.resolvedUri !== uri
          ) {
            return failure('integrity', uri, mount.primary.id, 'vfs-range-provenance-mismatch');
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
        (result) =>
          result.kind === 'success' ? { ...result, bytes: new Uint8Array(result.bytes) } : result
      );
      if (outcome.kind === 'success') {
        if (expectedRevision !== undefined && outcome.revision !== expectedRevision) {
          return failure('integrity', uri, mount.primary.id, 'vfs-revision-mismatch');
        }
        if (expectedIntegrity !== undefined) {
          const expectedDigest = validateExpectedIntegrity(expectedIntegrity);
          const actualDigest = new IncrementalSha256().update(outcome.bytes).digest();
          if (actualDigest !== expectedDigest) {
            return failure('integrity', uri, mount.primary.id, 'vfs-integrity-mismatch');
          }
        }
      }
      return outcome;
    } catch (error) {
      if (signal?.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
        return failure('aborted', uri, mount.primary.id);
      }
      return failure('provider-failure', uri, mount.primary.id);
    }
  }

  /** Opens a single-consumer stream session over the resolved resource. */
  async openStream(input: VFSStreamRequest): Promise<VFSStreamOpenResult> {
    const rawUri = input.uri;
    const expectedLength = input.expectedLength;
    const expectedIntegrity = input.expectedIntegrity;
    const highWaterMarkBytes = input.highWaterMarkBytes;
    const signal = input.signal;

    let uri: CanonicalVFSUri;
    try {
      uri = validateRequestInput(rawUri, expectedLength, expectedIntegrity, highWaterMarkBytes);
    } catch {
      return invalidRequest('Invalid VFS stream request.');
    }

    if (signal?.aborted) return failure('aborted', uri);
    const resolved = this.#resolveMount(uri);
    if ('kind' in resolved) return resolved;

    const { mount, path } = resolved;
    if (
      mount.primary.capabilities.stream !== true ||
      typeof mount.primary.openStream !== 'function'
    ) {
      return unsupportedChannel(uri, mount.primary.id, 'stream sessions');
    }

    try {
      const streamOptions = Object.freeze({
        ...(signal !== undefined && { signal }),
        ...(highWaterMarkBytes !== undefined && { highWaterMarkBytes }),
        ...(expectedLength !== undefined && { expectedLength }),
        ...(expectedIntegrity !== undefined && { expectedIntegrity })
      });
      const result = await mount.primary.openStream(path, streamOptions);
      if (result.kind !== 'session') {
        return failure(result.kind, uri, mount.primary.id, result.code);
      }
      if (
        result.session.metadata.providerId !== mount.primary.id ||
        result.session.metadata.resolvedUri !== uri
      ) {
        result.session.cancel();
        return failure('integrity', uri, mount.primary.id, 'vfs-stream-provenance-mismatch');
      }
      const originalSession = result.session;
      const wrappedCompletion = originalSession.completion.then((outcome) => {
        if (outcome.kind !== 'complete') return outcome;
        const err = checkIntegrityExpectations(
          outcome.verification.byteLength,
          outcome.verification,
          uri,
          originalSession.metadata.providerId,
          expectedLength,
          expectedIntegrity
        );
        return err ?? outcome;
      });

      const wrappedSession: VFSStreamSession = {
        metadata: originalSession.metadata,
        chunks: originalSession.chunks,
        completion: wrappedCompletion,
        cancel: () => originalSession.cancel()
      };

      return Object.freeze({
        kind: 'session',
        session: Object.freeze(wrappedSession)
      });
    } catch (error) {
      if (signal?.aborted) return failure('aborted', uri, mount.primary.id);
      return failure('provider-failure', uri, mount.primary.id);
    }
  }

  /** Acquires an encoded platform payload lease. */
  async acquirePayloadLease(input: VFSPayloadRequest): Promise<VFSPayloadLeaseResult> {
    const rawUri = input.uri;
    const expectedLength = input.expectedLength;
    const expectedIntegrity = input.expectedIntegrity;
    const signal = input.signal;

    let uri: CanonicalVFSUri;
    try {
      uri = validateRequestInput(rawUri, expectedLength, expectedIntegrity);
    } catch {
      return invalidRequest('Invalid VFS payload request.');
    }

    if (signal?.aborted) return failure('aborted', uri);
    const resolved = this.#resolveMount(uri);
    if ('kind' in resolved) return resolved;

    const { mount, path } = resolved;
    if (
      mount.primary.capabilities.payload !== true ||
      typeof mount.primary.acquirePayloadLease !== 'function'
    ) {
      return unsupportedChannel(uri, mount.primary.id, 'platform payload leases');
    }

    try {
      const payloadOptions = Object.freeze({
        ...(signal !== undefined && { signal }),
        ...(expectedLength !== undefined && { expectedLength }),
        ...(expectedIntegrity !== undefined && { expectedIntegrity })
      });
      const result = await mount.primary.acquirePayloadLease(path, payloadOptions);
      if (result.kind !== 'lease') {
        return failure(result.kind, uri, mount.primary.id, result.code);
      }
      if (result.lease.providerId !== mount.primary.id || result.lease.resolvedUri !== uri) {
        result.lease.release();
        return failure('integrity', uri, mount.primary.id, 'vfs-payload-provenance-mismatch');
      }

      const err = checkIntegrityExpectations(
        result.lease.byteLength,
        result.lease.verification,
        uri,
        mount.primary.id,
        expectedLength,
        expectedIntegrity
      );
      if (err !== null) {
        result.lease.release();
        return err;
      }

      let released = false;
      const wrappedLease: VFSPayloadLease = {
        resolvedUri: result.lease.resolvedUri,
        providerId: result.lease.providerId,
        revision: result.lease.revision,
        verification: result.lease.verification,
        byteLength: result.lease.byteLength,
        payload: result.lease.payload,
        ...(result.lease.mime === undefined ? {} : { mime: result.lease.mime }),
        release() {
          if (released) return;
          released = true;
          result.lease.release();
        }
      };

      return Object.freeze({
        kind: 'lease',
        lease: Object.freeze(wrappedLease)
      });
    } catch {
      if (signal?.aborted) return failure('aborted', uri, mount.primary.id);
      return failure('provider-failure', uri, mount.primary.id);
    }
  }

  #resolveMount(uri: CanonicalVFSUri): ResolvedVFSMount | VFSBoundaryFailure {
    try {
      return this.#mounts.resolve(uri);
    } catch {
      return Object.freeze({
        kind: 'mount-not-found',
        code: 'vfs-mount-not-found',
        message: 'No VFS mount matches the requested URI.',
        requestedUri: uri
      });
    }
  }
}

function validateRequestInput(
  rawUri: string,
  expectedLength?: number,
  expectedIntegrity?: string,
  highWaterMarkBytes?: number
): CanonicalVFSUri {
  const uri = normalizeVFSUri(rawUri);
  if (
    expectedLength !== undefined &&
    (!Number.isSafeInteger(expectedLength) || expectedLength < 0)
  ) {
    throw new Error('Invalid expected length.');
  }
  if (expectedIntegrity !== undefined) {
    validateExpectedIntegrity(expectedIntegrity);
  }
  if (
    highWaterMarkBytes !== undefined &&
    (!Number.isSafeInteger(highWaterMarkBytes) || highWaterMarkBytes <= 0)
  ) {
    throw new Error('Invalid highWaterMarkBytes.');
  }
  return uri;
}

function invalidRequest(message: string): VFSBoundaryFailure {
  return Object.freeze({ kind: 'invalid-request', code: 'vfs-invalid-request', message });
}

function unsupportedChannel(
  uri: CanonicalVFSUri,
  providerId: string,
  channel: string
): VFSBoundaryFailure {
  return Object.freeze({
    kind: 'unsupported-channel',
    code: 'vfs-unsupported-channel',
    message: `VFS provider "${providerId}" does not support ${channel}.`,
    requestedUri: uri
  });
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
    ...(providerId !== undefined && { providerId })
  });
}
