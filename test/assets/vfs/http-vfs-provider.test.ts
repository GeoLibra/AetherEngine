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
    body: null
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

  test('slices HTTP 200 full body response when server ignores Range header', async () => {
    const full = new Uint8Array([0, 10, 20, 30, 40, 50]);
    const provider = new HttpVFSProvider({
      id: 'mock-http',
      baseUrl: 'https://cdn.example.com/assets',
      baseUri,
      transport: async () =>
        createMockResponse({
          status: 200,
          bodyBytes: full,
          headers: { ETag: '"full-rev"' }
        })
    });

    const result = await provider.readRange(
      toNormalizedMountPath(['package.pkg']),
      { offset: 2, length: 3 },
      {}
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success') {
      expect(Array.from(result.bytes)).toEqual([20, 30, 40]);
      expect(result.totalLength).toBe(6);
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
});
