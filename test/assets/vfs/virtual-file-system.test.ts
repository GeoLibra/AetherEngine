import { describe, expect, test } from 'vitest';
import {
  VirtualFileSystem,
  DEFAULT_VFS_READ_POLICY,
  MemoryVFSProvider,
  normalizeVFSUri,
  parseCanonicalVFSUri,
  defineVFSProviderId,
  type VFSProvider,
  type VFSProviderReadResult,
  type VFSReadPolicy
} from '../../../src/assets/vfs';

const uri = normalizeVFSUri('asset://folder/item');
const bytes = new Uint8Array([1, 2, 3]);
function setup(
  outcomes: readonly (VFSProviderReadResult['kind'] | 'throws' | 'bad-length')[],
  cacheCount = 0,
  policy: VFSReadPolicy = DEFAULT_VFS_READ_POLICY
) {
  const calls: string[] = [];
  const providers = outcomes.map((kind, index): VFSProvider => ({
    id: defineVFSProviderId(`provider-${index}`),
    capabilities: new MemoryVFSProvider('template').capabilities,
    async read(path) {
      calls.push(`${index}:${path}`);
      if (kind === 'throws') throw new Error('/private/secret?token=hidden');
      if (kind === 'success' || kind === 'bad-length')
        return {
          kind: 'success',
          bytes,
          resolvedUri: uri,
          revision: '1',
          contentLength: kind === 'bad-length' ? 99 : 3,
          providerId: this.id
        };
      return { kind, code: 'provider-code', message: '/private/secret?token=hidden' };
    }
  }));
  const vfs = new VirtualFileSystem();
  const root = normalizeVFSUri('asset://folder');
  vfs.mount({
    root,
    scheme: parseCanonicalVFSUri(root).scheme,
    primary: providers[cacheCount]!,
    caches: providers.slice(0, cacheCount),
    ...(providers[cacheCount + 1] ? { fallback: providers[cacheCount + 1]! } : {}),
    policy
  });
  return { vfs, calls, providers };
}

describe('VirtualFileSystem', () => {
  test('skips caches and does not use a policy-disabled fallback', async () => {
    const fixture = setup(['success', 'offline', 'success'], 1, {
      consultCaches: false,
      fallbackOn: []
    });
    expect((await fixture.vfs.read({ uri })).kind).toBe('offline');
    expect(fixture.calls).toEqual(['1:/item']);
  });
  test.each([
    { outcomes: ['success', 'success'], caches: 1, calls: ['0:/item'], result: 'success' },
    {
      outcomes: ['not-found', 'not-found', 'success'],
      caches: 2,
      calls: ['0:/item', '1:/item', '2:/item'],
      result: 'success'
    },
    { outcomes: ['offline', 'success'], caches: 1, calls: ['0:/item'], result: 'offline' },
    {
      outcomes: ['not-found', 'success'],
      caches: 0,
      calls: ['0:/item', '1:/item'],
      result: 'success'
    },
    {
      outcomes: ['offline', 'success'],
      caches: 0,
      calls: ['0:/item', '1:/item'],
      result: 'success'
    },
    ...(['permission', 'integrity', 'aborted', 'provider-failure'] as const).map((kind) => ({
      outcomes: [kind, 'success'],
      caches: 0,
      calls: ['0:/item'],
      result: kind
    })),
    { outcomes: ['bad-length', 'success'], caches: 0, calls: ['0:/item'], result: 'integrity' }
  ])(
    'follows declared provider ordering: $outcomes',
    async ({ outcomes, caches, calls, result }) => {
      const fixture = setup(outcomes as Parameters<typeof setup>[0], caches);
      expect((await fixture.vfs.read({ uri })).kind).toBe(result);
      expect(fixture.calls).toEqual(calls);
    }
  );

  test.each([
    { uri: 'asset://../secret' },
    { uri, expectedLength: -1 },
    { uri, expectedLength: 1.5 },
    { uri, expectedIntegrity: 'invalid' }
  ])('rejects invalid requests before dispatch: %j', async (request) => {
    const fixture = setup(['success']);
    expect((await fixture.vfs.read(request)).kind).toBe('invalid-request');
    expect(fixture.calls).toEqual([]);
  });

  test('reports absent mounts without fabricating a provider identity', async () => {
    expect(await new VirtualFileSystem().read({ uri })).toEqual({
      kind: 'mount-not-found',
      code: 'vfs-mount-not-found',
      message: 'No VFS mount matches the requested URI.',
      requestedUri: uri
    });
  });

  test.each(['throws', 'permission'] as const)('redacts provider diagnostics: %s', async (kind) => {
    const { vfs } = setup([kind]);
    const result = await vfs.read({ uri });
    expect(JSON.stringify(result)).not.toMatch(/secret|token|hidden/);
    expect(result).toMatchObject({ providerId: 'provider-0', requestedUri: uri });
  });

  test('honors cancellation before dispatch and after provider completion', async () => {
    const fixture = setup(['success']);
    const controller = new AbortController();
    controller.abort();
    expect((await fixture.vfs.read({ uri, signal: controller.signal })).kind).toBe('aborted');
    expect(fixture.calls).toEqual([]);
    const late = new AbortController();
    const pending = fixture.vfs.read({ uri, signal: late.signal });
    late.abort();
    expect((await pending).kind).toBe('aborted');
  });

  test('snapshots a mutable request before the provider await', async () => {
    const fixture = setup(['success']);
    const request: { uri: string; expectedLength: number } = { uri, expectedLength: 3 };
    const pending = fixture.vfs.read(request);
    request.expectedLength = 999;
    expect((await pending).kind).toBe('success');
  });

  test('validates expected digest and publishes detached bytes', async () => {
    const { vfs } = setup(['success', 'success']);
    expect((await vfs.read({ uri, expectedIntegrity: '0'.repeat(64) })).kind).toBe('integrity');
    const result = await vfs.read({ uri });
    if (result.kind !== 'success') throw new Error('Expected success.');
    result.bytes[0] = 99;
    expect(bytes[0]).toBe(1);
  });
});
