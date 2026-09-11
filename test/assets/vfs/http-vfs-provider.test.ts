import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VFS_READ_POLICY,
  HttpTransportResponse,
  HttpVFSProvider,
  VirtualFileSystem,
  normalizeVFSUri,
  toNormalizedMountPath
} from '../../../src/assets/vfs';

function createMockResponse(params: {
  status: number;
  bodyBytes?: Uint8Array;
  headers?: Record<string, string>;
  body?: AsyncIterable<Uint8Array> | null;
}): HttpTransportResponse {
  const headersMap = new Map<string, string>();
  if (params.headers) {
    for (const [k, v] of Object.entries(params.headers)) {
      headersMap.set(k.toLowerCase(), v);
    }
  }
  return {
    status: params.status,
    statusText: params.status === 200 ? 'OK' : 'Mock Status',
    headers: {
      get(name: string): string | null {
        return headersMap.get(name.toLowerCase()) ?? null;
      }
    },
    arrayBuffer: async () => {
      const bytes = params.bodyBytes ?? new Uint8Array();
      return new Uint8Array(bytes).buffer as ArrayBuffer;
    },
    body: params.body !== undefined ? params.body : null
  };
}

describe('HttpVFSProvider contracts', () => {
  const baseUri = normalizeVFSUri('asset://cdn');

  test('performs successful full read on HTTP 200', async () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const provider = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com/assets',
      baseUri,
      transport: async () =>
        createMockResponse({
          status: 200,
          bodyBytes: payload,
          headers: { ETag: '"v123"', 'Content-Type': 'application/octet-stream' }
        })
    });

    const result = await provider.read(toNormalizedMountPath(['models', 'car.glb']), {});
    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4, 5]);
      expect(result.revision).toBe('v123');
      expect(result.contentLength).toBe(5);
      expect(result.mime).toBe('application/octet-stream');
    }
  });

  test('handles HTTP 206 Partial Content for range read', async () => {
    const slice = new Uint8Array([20, 30]);
    const provider = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com/assets',
      baseUri,
      transport: async () =>
        createMockResponse({
          status: 206,
          bodyBytes: slice,
          headers: {
            'Content-Range': 'bytes 2-3/10',
            ETag: '"rev1"'
          }
        })
    });

    const result = await provider.readRange(
      toNormalizedMountPath(['package.pkg']),
      { offset: 2, length: 2 },
      {}
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(Array.from(result.bytes)).toEqual([20, 30]);
      expect(result.range).toEqual({ offset: 2, length: 2 });
      expect(result.totalLength).toBe(10);
      expect(result.revision).toBe('rev1');
    }
  });

  test('rejects HTTP 200 by default and slices when allowFullBodyFallback is enabled within maxBodyBytes', async () => {
    const full = new Uint8Array([0, 10, 20, 30, 40, 50]);
    const provider = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com/assets',
      baseUri,
      transport: async () =>
        createMockResponse({
          status: 200,
          bodyBytes: full,
          headers: { ETag: '"full-rev"', 'content-length': '6' }
        })
    });

    // 1. By default, HTTP 200 is rejected with unsupported-channel
    const defaultResult = await provider.readRange(
      toNormalizedMountPath(['package.pkg']),
      { offset: 2, length: 3 },
      {}
    );
    expect(defaultResult.kind).toBe('unsupported-channel');
    if (defaultResult.kind !== 'success') {
      expect(defaultResult.code).toBe('vfs-http-range-not-supported');
    }

    // 2. If maxBodyBytes is exceeded, rejects with provider-failure vfs-http-body-too-large
    const exceededResult = await provider.readRange(
      toNormalizedMountPath(['package.pkg']),
      { offset: 2, length: 3 },
      { allowFullBodyFallback: true, maxBodyBytes: 4 }
    );
    expect(exceededResult.kind).toBe('provider-failure');
    if (exceededResult.kind !== 'success') {
      expect(exceededResult.code).toBe('vfs-http-body-too-large');
    }

    // 3. If allowFullBodyFallback is true and within maxBodyBytes, slices correctly
    const fallbackResult = await provider.readRange(
      toNormalizedMountPath(['package.pkg']),
      { offset: 2, length: 3 },
      { allowFullBodyFallback: true, maxBodyBytes: 10 }
    );
    expect(fallbackResult.kind).toBe('success');
    if (fallbackResult.kind === 'success') {
      expect(Array.from(fallbackResult.bytes)).toEqual([20, 30, 40]);
      expect(fallbackResult.totalLength).toBe(6);
    }
  });

  test('maps HTTP 404 to not-found and HTTP 401/403 to permission', async () => {
    const provider404 = new HttpVFSProvider({
      id: 'mock-404',
      baseUrl: 'https://cdn.example.com',
      baseUri,
      transport: async () => createMockResponse({ status: 404 })
    });
    const res404 = await provider404.read(toNormalizedMountPath(['missing.bin']), {});
    expect(res404.kind).toBe('not-found');

    const provider403 = new HttpVFSProvider({
      id: 'mock-403',
      baseUrl: 'https://cdn.example.com',
      baseUri,
      transport: async () => createMockResponse({ status: 403 })
    });
    const res403 = await provider403.read(toNormalizedMountPath(['forbidden.bin']), {});
    expect(res403.kind).toBe('permission');
  });

  test('maps HTTP 416 to range-not-satisfiable', async () => {
    const provider = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com',
      baseUri,
      transport: async () => createMockResponse({ status: 416 })
    });

    const result = await provider.readRange(
      toNormalizedMountPath(['out.bin']),
      { offset: 100, length: 50 },
      {}
    );
    expect(result.kind).toBe('range-not-satisfiable');
  });

  test('maps HTTP 429 and 5xx to provider-failure with retry metadata', async () => {
    const provider = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com',
      baseUri,
      transport: async () =>
        createMockResponse({
          status: 429,
          headers: { 'Retry-After': '5' }
        })
    });

    const result = await provider.read(toNormalizedMountPath(['throttled.bin']), {});
    expect(result.kind).toBe('provider-failure');
    if (result.kind === 'provider-failure') {
      expect(result.retry?.canRetry).toBe(true);
      expect(result.retry?.retryAfterMs).toBe(5000);
    }
  });

  test('enforces max body size limit', async () => {
    const provider = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com',
      baseUri,
      maxBodyBytes: 10,
      transport: async () =>
        createMockResponse({
          status: 200,
          bodyBytes: new Uint8Array(20) // Exceeds limit
        })
    });

    const result = await provider.read(toNormalizedMountPath(['huge.bin']), {});
    expect(result.kind).toBe('provider-failure');
    if (result.kind === 'provider-failure') {
      expect(result.code).toBe('vfs-http-body-too-large');
    }
  });

  test('sends If-Range header when expectedRevision is provided', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const provider = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com/assets',
      baseUri,
      transport: async (_url, init) => {
        capturedHeaders = init?.headers;
        return createMockResponse({
          status: 206,
          bodyBytes: new Uint8Array([20, 30]),
          headers: {
            'Content-Range': 'bytes 2-3/10',
            ETag: '"rev-pinned"'
          }
        });
      }
    });

    const result = await provider.readRange(
      toNormalizedMountPath(['package.pkg']),
      { offset: 2, length: 2 },
      { expectedRevision: 'rev-pinned' }
    );

    expect(capturedHeaders?.['If-Range']).toBe('"rev-pinned"');
    expect(result.kind).toBe('success');
  });

  test('rejects HTTP range reads missing strong ETag or having weak ETag', async () => {
    const providerNoETag = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com/assets',
      baseUri,
      transport: async () =>
        createMockResponse({
          status: 206,
          bodyBytes: new Uint8Array([20, 30]),
          headers: {
            'Content-Range': 'bytes 2-3/10'
          }
        })
    });

    const resNoETag = await providerNoETag.readRange(
      toNormalizedMountPath(['package.pkg']),
      { offset: 2, length: 2 },
      {}
    );
    expect(resNoETag.kind).toBe('integrity');
    if (resNoETag.kind === 'integrity') {
      expect(resNoETag.code).toBe('vfs-http-missing-validator');
    }

    const providerWeakETag = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com/assets',
      baseUri,
      transport: async () =>
        createMockResponse({
          status: 206,
          bodyBytes: new Uint8Array([20, 30]),
          headers: {
            'Content-Range': 'bytes 2-3/10',
            ETag: 'W/"weak-1"'
          }
        })
    });

    const resWeak = await providerWeakETag.readRange(
      toNormalizedMountPath(['package.pkg']),
      { offset: 2, length: 2 },
      {}
    );
    expect(resWeak.kind).toBe('integrity');
    if (resWeak.kind === 'integrity') {
      expect(resWeak.code).toBe('vfs-http-missing-validator');
    }
  });

  test('rejects openStream when response body does not support streaming', async () => {
    const provider = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com',
      baseUri,
      transport: async () =>
        createMockResponse({
          status: 200,
          bodyBytes: new Uint8Array([1, 2, 3]),
          body: null
        })
    });

    const result = await provider.openStream(toNormalizedMountPath(['stream.bin']), {});
    expect(result.kind).toBe('unsupported-channel');
    if (result.kind === 'unsupported-channel') {
      expect(result.code).toBe('vfs-http-stream-not-supported');
    }
  });

  test('opens stream session when response body supports streaming', async () => {
    async function* gen() {
      yield new Uint8Array([1, 2]);
      yield new Uint8Array([3, 4]);
    }
    const provider = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com',
      baseUri,
      transport: async () =>
        createMockResponse({
          status: 200,
          headers: { ETag: '"stream-rev"', 'content-length': '4' },
          body: gen()
        })
    });

    const result = await provider.openStream(toNormalizedMountPath(['stream.bin']), {});
    expect(result.kind).toBe('session');
    if (result.kind === 'session') {
      const chunks: number[] = [];
      for await (const chunk of result.session.chunks) {
        chunks.push(...chunk.bytes);
      }
      expect(chunks).toEqual([1, 2, 3, 4]);
      const completion = await result.session.completion;
      expect(completion.kind).toBe('complete');
    }
  });
});
