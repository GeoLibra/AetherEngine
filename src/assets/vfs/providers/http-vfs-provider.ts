/** @file HTTP VFS provider implementing full reads, byte ranges, and stream sessions. */

import {
  formatHttpRangeHeader,
  parseContentRangeHeader,
  sliceRangeBytes,
  validateByteRange
} from '../range';
import { createVFSStreamSession } from '../stream';
import type {
  ByteRange,
  CanonicalVFSUri,
  NormalizedMountPath,
  VFSProvider,
  VFSProviderCapabilities,
  VFSProviderId,
  VFSProviderRangeReadOptions,
  VFSProviderRangeReadResult,
  VFSProviderReadResult,
  VFSProviderStreamOpenResult,
  VFSReadOptions,
  VFSStreamOptions
} from '../types';
import { normalizeVFSUri } from '../uri';
import { defineVFSProviderId } from './memory-vfs-provider';

export interface HttpTransportResponse {
  readonly status: number;
  readonly statusText: string;
  readonly headers: {
    get(name: string): string | null;
  };
  arrayBuffer(): Promise<ArrayBuffer>;
  readonly body?: AsyncIterable<Uint8Array> | null;
}

export interface HttpTransportRequestInit {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly signal?: AbortSignal;
}

export type HttpTransport = (
  url: string,
  init?: HttpTransportRequestInit
) => Promise<HttpTransportResponse>;

export interface HttpVFSProviderOptions {
  readonly id: string;
  readonly baseUrl: string;
  readonly baseUri: CanonicalVFSUri;
  readonly transport?: HttpTransport;
  readonly defaultHeaders?: Readonly<Record<string, string>>;
  readonly maxBodyBytes?: number;
  readonly timeoutMs?: number;
  readonly credentialPartition?: string;
}

const HTTP_CAPABILITIES: VFSProviderCapabilities = Object.freeze({
  read: true,
  range: true,
  stream: true,
  write: false,
  watch: false
});

/** Reads remote assets over HTTP transport with Range, conditional headers, and stream sessions. */
export class HttpVFSProvider implements VFSProvider {
  readonly id: VFSProviderId;
  readonly capabilities = HTTP_CAPABILITIES;
  readonly #baseUrl: string;
  readonly #baseUri: CanonicalVFSUri;
  readonly #transport: HttpTransport;
  readonly #defaultHeaders: Readonly<Record<string, string>>;
  readonly #maxBodyBytes: number;

  constructor(options: HttpVFSProviderOptions) {
    this.id = defineVFSProviderId(options.id);
    this.#baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.#baseUri = normalizeVFSUri(options.baseUri);
    this.#transport = options.transport ?? defaultFetchTransport;
    this.#defaultHeaders = options.defaultHeaders ?? Object.freeze({});
    this.#maxBodyBytes = options.maxBodyBytes ?? 128 * 1024 * 1024;
  }

  /** Performs a full HTTP read. */
  async read(path: NormalizedMountPath, options: VFSReadOptions): Promise<VFSProviderReadResult> {
    const url = `${this.#baseUrl}${path}`;
    const uri = normalizeVFSUri(`${this.#baseUri}${path}`);

    try {
      const response = await this.#transport(url, {
        method: 'GET',
        headers: { ...this.#defaultHeaders },
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });

      if (response.status === 404) {
        return Object.freeze({
          kind: 'not-found',
          code: 'vfs-http-404',
          message: `Resource not found at ${url}.`
        });
      }
      if (response.status === 401 || response.status === 403) {
        return Object.freeze({
          kind: 'permission',
          code: 'vfs-http-unauthorized',
          message: `HTTP ${response.status} unauthorized access to ${url}.`
        });
      }
      if (response.status === 429 || response.status >= 500) {
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : undefined;
        return Object.freeze({
          kind: 'provider-failure',
          code: `vfs-http-${response.status}`,
          message: `Transient HTTP server error ${response.status} at ${url}.`,
          retry: { canRetry: true, ...(retryAfterMs ? { retryAfterMs } : {}) }
        });
      }
      if (response.status !== 200) {
        return Object.freeze({
          kind: 'provider-failure',
          code: `vfs-http-${response.status}`,
          message: `Unexpected HTTP status ${response.status}.`
        });
      }

      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);

      if (bytes.byteLength > this.#maxBodyBytes) {
        return Object.freeze({
          kind: 'provider-failure',
          code: 'vfs-http-body-too-large',
          message: `HTTP response body (${bytes.byteLength}) exceeds max body budget (${this.#maxBodyBytes}).`
        });
      }

      const revision = extractRevision(response);
      const mime = response.headers.get('content-type') ?? undefined;

      return {
        kind: 'success',
        bytes,
        resolvedUri: uri,
        revision,
        contentLength: bytes.byteLength,
        providerId: this.id,
        ...(mime ? { mime } : {})
      };
    } catch (error) {
      if (options.signal?.aborted) {
        return Object.freeze({
          kind: 'aborted',
          code: 'vfs-read-aborted',
          message: 'HTTP read request was aborted.'
        });
      }
      return Object.freeze({
        kind: 'provider-failure',
        code: 'vfs-http-transport-error',
        message: error instanceof Error ? error.message : 'HTTP transport error.'
      });
    }
  }

  /** Performs an HTTP range read using standard Range request header. */
  async readRange(
    path: NormalizedMountPath,
    range: ByteRange,
    options: VFSProviderRangeReadOptions
  ): Promise<VFSProviderRangeReadResult> {
    validateByteRange(range);
    const url = `${this.#baseUrl}${path}`;
    const uri = normalizeVFSUri(`${this.#baseUri}${path}`);

    try {
      const rangeHeader = formatHttpRangeHeader(range);
      const headers: Record<string, string> = {
        ...this.#defaultHeaders,
        Range: rangeHeader
      };

      const response = await this.#transport(url, {
        method: 'GET',
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });

      if (response.status === 416) {
        return Object.freeze({
          kind: 'range-not-satisfiable',
          code: 'vfs-http-416',
          message: `HTTP 416 Range Not Satisfiable for range ${rangeHeader}.`,
          requestedUri: uri,
          providerId: this.id
        });
      }
      if (response.status === 404) {
        return Object.freeze({
          kind: 'not-found',
          code: 'vfs-http-404',
          message: `Resource not found at ${url}.`,
          requestedUri: uri,
          providerId: this.id
        });
      }
      if (response.status === 401 || response.status === 403) {
        return Object.freeze({
          kind: 'permission',
          code: 'vfs-http-unauthorized',
          message: `HTTP ${response.status} unauthorized access to ${url}.`,
          requestedUri: uri,
          providerId: this.id
        });
      }

      const revision = extractRevision(response);

      if (response.status === 206) {
        const contentRange = response.headers.get('Content-Range');
        if (!contentRange) {
          return Object.freeze({
            kind: 'integrity',
            code: 'vfs-http-missing-content-range',
            message: 'HTTP 206 response missing required Content-Range header.',
            requestedUri: uri,
            providerId: this.id
          });
        }
        const parsedRange = parseContentRangeHeader(contentRange, range);
        const buffer = await response.arrayBuffer();
        const bytes = new Uint8Array(buffer);

        if (bytes.byteLength !== range.length) {
          return Object.freeze({
            kind: 'integrity',
            code: 'vfs-http-range-length-mismatch',
            message: `Delivered bytes (${bytes.byteLength}) does not match requested range length (${range.length}).`,
            requestedUri: uri,
            providerId: this.id
          });
        }

        return {
          kind: 'success',
          bytes,
          range,
          totalLength: parsedRange.totalLength,
          resolvedUri: uri,
          revision,
          providerId: this.id,
          ...(response.headers.get('content-type')
            ? { mime: response.headers.get('content-type')! }
            : {})
        };
      }

      if (response.status === 200) {
        if (options.allowFullBodyFallback !== true) {
          return Object.freeze({
            kind: 'unsupported-channel',
            code: 'vfs-http-range-not-supported',
            message:
              'Server returned full body (HTTP 200) for range request, but allowFullBodyFallback was not enabled.',
            requestedUri: uri,
            providerId: this.id
          });
        }

        const contentLengthHeader = response.headers.get('content-length');
        const declaredLength = contentLengthHeader ? Number(contentLengthHeader) : null;
        if (
          options.maxBodyBytes !== undefined &&
          declaredLength !== null &&
          declaredLength > options.maxBodyBytes
        ) {
          return Object.freeze({
            kind: 'provider-failure',
            code: 'vfs-http-body-too-large',
            message: `HTTP 200 full body length (${declaredLength}) exceeds maxBodyBytes (${options.maxBodyBytes}).`,
            requestedUri: uri,
            providerId: this.id
          });
        }

        const buffer = await response.arrayBuffer();
        const fullBytes = new Uint8Array(buffer);
        if (options.maxBodyBytes !== undefined && fullBytes.byteLength > options.maxBodyBytes) {
          return Object.freeze({
            kind: 'provider-failure',
            code: 'vfs-http-body-too-large',
            message: `HTTP 200 full body length (${fullBytes.byteLength}) exceeds maxBodyBytes (${options.maxBodyBytes}).`,
            requestedUri: uri,
            providerId: this.id
          });
        }

        if (range.offset + range.length > fullBytes.byteLength) {
          return Object.freeze({
            kind: 'range-not-satisfiable',
            code: 'vfs-http-range-out-of-bounds',
            message: `Requested range exceeds delivered full body length (${fullBytes.byteLength}).`,
            requestedUri: uri,
            providerId: this.id
          });
        }
        const sliced = sliceRangeBytes(fullBytes, range);
        return {
          kind: 'success',
          bytes: sliced,
          range,
          totalLength: fullBytes.byteLength,
          resolvedUri: uri,
          revision,
          providerId: this.id,
          ...(response.headers.get('content-type')
            ? { mime: response.headers.get('content-type')! }
            : {})
        };
      }

      return Object.freeze({
        kind: 'provider-failure',
        code: `vfs-http-${response.status}`,
        message: `Unexpected HTTP status ${response.status} for range read.`,
        requestedUri: uri,
        providerId: this.id
      });
    } catch (error) {
      if (options.signal?.aborted) {
        return Object.freeze({
          kind: 'aborted',
          code: 'vfs-read-aborted',
          message: 'HTTP range read request was aborted.',
          requestedUri: uri,
          providerId: this.id
        });
      }
      return Object.freeze({
        kind: 'provider-failure',
        code: 'vfs-http-transport-error',
        message: error instanceof Error ? error.message : 'HTTP transport error.',
        requestedUri: uri,
        providerId: this.id
      });
    }
  }

  /** Opens single-consumer chunk stream over HTTP response. */
  async openStream(
    path: NormalizedMountPath,
    options: VFSStreamOptions
  ): Promise<VFSProviderStreamOpenResult> {
    const url = `${this.#baseUrl}${path}`;
    const uri = normalizeVFSUri(`${this.#baseUri}${path}`);

    try {
      const response = await this.#transport(url, {
        method: 'GET',
        headers: { ...this.#defaultHeaders },
        ...(options.signal === undefined ? {} : { signal: options.signal })
      });

      if (response.status !== 200) {
        return Object.freeze({
          kind: response.status === 404 ? 'not-found' : 'provider-failure',
          code: `vfs-http-${response.status}`,
          message: `HTTP stream open failed with status ${response.status}.`,
          requestedUri: uri,
          providerId: this.id
        });
      }

      const contentLengthHeader = response.headers.get('content-length');
      const contentLength = contentLengthHeader ? Number(contentLengthHeader) : null;
      const revision = extractRevision(response);

      let chunkStream: AsyncIterable<Uint8Array>;
      if (response.body) {
        chunkStream = response.body;
      } else {
        // Fallback: arrayBuffer split into chunks
        const buffer = await response.arrayBuffer();
        const allBytes = new Uint8Array(buffer);
        const chunkSize = options.highWaterMarkBytes ?? 64 * 1024;
        async function* generator() {
          for (let offset = 0; offset < allBytes.byteLength; offset += chunkSize) {
            yield allBytes.subarray(offset, Math.min(offset + chunkSize, allBytes.byteLength));
          }
        }
        chunkStream = generator();
      }

      const session = createVFSStreamSession({
        metadata: Object.freeze({
          resolvedUri: uri,
          providerId: this.id,
          revision,
          contentLength,
          ...(response.headers.get('content-type')
            ? { mime: response.headers.get('content-type')! }
            : {})
        }),
        source: chunkStream,
        ...(options.expectedLength !== undefined
          ? { expectedLength: options.expectedLength }
          : contentLength !== null
            ? { expectedLength: contentLength }
            : {}),
        ...(options.expectedIntegrity === undefined
          ? {}
          : { expectedIntegrity: options.expectedIntegrity }),
        ...(options.highWaterMarkBytes === undefined
          ? {}
          : { highWaterMarkBytes: options.highWaterMarkBytes })
      });

      return Object.freeze({
        kind: 'session',
        session
      });
    } catch (error) {
      if (options.signal?.aborted) {
        return Object.freeze({
          kind: 'aborted',
          code: 'vfs-stream-aborted',
          message: 'HTTP stream open was aborted.',
          requestedUri: uri,
          providerId: this.id
        });
      }
      return Object.freeze({
        kind: 'provider-failure',
        code: 'vfs-http-transport-error',
        message: error instanceof Error ? error.message : 'HTTP stream error.',
        requestedUri: uri,
        providerId: this.id
      });
    }
  }
}

function extractRevision(response: HttpTransportResponse): string {
  const etag = response.headers.get('etag');
  if (etag && !etag.startsWith('W/')) {
    return etag.replace(/"/g, '');
  }
  const lastModified = response.headers.get('last-modified');
  if (lastModified) {
    return lastModified;
  }
  return '1';
}

async function defaultFetchTransport(
  url: string,
  init?: HttpTransportRequestInit
): Promise<HttpTransportResponse> {
  const initObj: RequestInit = {};
  if (init?.method !== undefined) initObj.method = init.method;
  if (init?.headers !== undefined) initObj.headers = init.headers;
  if (init?.signal !== undefined) initObj.signal = init.signal;
  const res = await globalThis.fetch(url, initObj);
  return {
    status: res.status,
    statusText: res.statusText,
    headers: {
      get(name: string): string | null {
        return res.headers.get(name);
      }
    },
    arrayBuffer: () => res.arrayBuffer(),
    body: res.body as unknown as AsyncIterable<Uint8Array> | null
  };
}
