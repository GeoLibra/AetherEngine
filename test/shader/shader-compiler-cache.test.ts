import { describe, expect, test } from 'vitest';
import {
  InMemoryShaderSourceResolver,
  ShaderArtifactCache,
  ShaderCompiler,
  createPersistentShaderCacheRecord,
  validatePersistentShaderCacheRecord,
  createShaderFallbackKey,
  selectCompatibleShaderFallback
} from '../../src/shader';
import type { WebGL2ShaderTranslationPort } from '../../src';

describe('shader compiler, cache and fallback', () => {
  test('uses complete order-independent cache keys and suppresses stale results', async () => {
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/main.flux': '@variant QUALITY: enum(low, high) = low;\n@vertex fn main() {}'
    });
    const compiler = new ShaderCompiler({
      resolver,
      validators: { wgsl: { validate: async () => [] } },
      versions: { compiler: 1, ir: 1, abi: 1, backend: 1 }
    });
    const first = await compiler.compile({
      revision: 1,
      source: { uri: 'asset://shader/main.flux', languageVersion: 1 },
      entries: ['main'],
      target: 'wgsl',
      variants: { QUALITY: 'high' },
      capabilities: []
    });
    const second = await compiler.compile({
      revision: 2,
      source: { uri: 'asset://shader/main.flux', languageVersion: 1 },
      entries: ['main'],
      target: 'wgsl',
      variants: { QUALITY: 'high' },
      capabilities: []
    });
    expect(first.status).toBe('compiled');
    expect(second.status).toBe('cached');
    expect(first.key).toBe(second.key);
    expect(first.status === 'compiled' && first.artifact.manifest.layoutHash).toMatch(
      /^[0-9a-f]{16}$/
    );
    expect(compiler.acceptFor('asset://shader/main.flux', first, 2)).toBe(false);
    expect(compiler.acceptFor('asset://shader/main.flux', second, 2)).toBe(true);
  });

  test('guards cache collisions and retains referenced entries during LRU eviction', () => {
    const cache = new ShaderArtifactCache<{ fingerprint: string }>({ maxEntries: 1 });
    const lease = cache.set('same', 'first', { fingerprint: 'a' });
    expect(() => cache.set('same', 'different', { fingerprint: 'b' })).toThrow('collision');
    cache.set('next', 'next', { fingerprint: 'c' }).release();
    expect(cache.has('same')).toBe(true);
    lease.release();
  });

  test('pins artifacts until retained submissions become terminal', async () => {
    const cache = new ShaderArtifactCache<string>({ maxEntries: 1 });
    const initial = cache.set('old', 'old-fingerprint', 'old-artifact');
    let complete!: (value: { status: 'completed' }) => void;
    const done = new Promise<{ status: 'completed' }>((resolve) => {
      complete = resolve;
    });
    expect(
      cache.retainForSubmission('old', 'old-fingerprint', {
        id: 1,
        status: 'pending',
        done
      })
    ).toBe(true);
    initial.release();
    cache.set('new', 'new-fingerprint', 'new-artifact').release();
    expect(cache.has('old')).toBe(true);

    complete({ status: 'completed' });
    await done;
    await Promise.resolve();
    expect(cache.has('old')).toBe(false);
    expect(cache.has('new')).toBe(true);
  });

  test('includes the approved translator identity and version in GLSL artifact keys', async () => {
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/glsl.flux': '@vertex fn main() {}'
    });
    const compile = (version: number) =>
      new ShaderCompiler({
        resolver,
        validators: { glsl300es: { validate: async () => [] } },
        webgl2Translator: testTranslator(version),
        versions: { compiler: 1, ir: 1, abi: 1, backend: 1 }
      }).compile({
        revision: 1,
        source: { uri: 'asset://shader/glsl.flux', languageVersion: 1 },
        entries: ['main'],
        target: 'glsl300es',
        variants: {},
        capabilities: []
      });

    const first = await compile(1);
    const second = await compile(2);
    expect(first.status).toBe('compiled');
    expect(second.status).toBe('compiled');
    expect(first.key).not.toBe(second.key);
  });

  test('selects fallback only for complete pipeline compatibility', () => {
    const wanted = createShaderFallbackKey({
      bindingLayout: 'b',
      vertexLayout: 'v',
      attachments: ['rgba8unorm'],
      sampleCount: 4
    });
    const compatible = { id: 'ok', compatibility: wanted };
    const wrongSamples = {
      id: 'bad',
      compatibility: createShaderFallbackKey({
        bindingLayout: 'b',
        vertexLayout: 'v',
        attachments: ['rgba8unorm'],
        sampleCount: 1
      })
    };
    expect(selectCompatibleShaderFallback(wanted, [wrongSamples, compatible])?.id).toBe('ok');
  });

  test('validates persistent cache version, integrity and device applicability', () => {
    const record = createPersistentShaderCacheRecord({
      key: 'k',
      fingerprint: 'f',
      backendVersion: 2,
      deviceKey: 'gpu-a',
      payload: 'compiled'
    });
    expect(
      validatePersistentShaderCacheRecord(record, { backendVersion: 2, deviceKey: 'gpu-a' })
    ).toEqual({ ok: true, payload: 'compiled' });
    expect(
      validatePersistentShaderCacheRecord(record, { backendVersion: 3, deviceKey: 'gpu-a' })
    ).toMatchObject({ ok: false, reason: 'version-mismatch' });
    expect(
      validatePersistentShaderCacheRecord(
        { ...record, payload: 'tampered' },
        { backendVersion: 2, deviceKey: 'gpu-a' }
      )
    ).toMatchObject({ ok: false, reason: 'integrity-mismatch' });
  });

  test('returns structured source resolution failures', async () => {
    const compiler = new ShaderCompiler({
      resolver: new InMemoryShaderSourceResolver({}),
      validators: { wgsl: { validate: async () => [] } },
      versions: { compiler: 1, ir: 1, abi: 1, backend: 1 }
    });
    const result = await compiler.compile({
      revision: 1,
      source: { uri: 'asset://missing.flux', languageVersion: 1 },
      entries: ['main'],
      target: 'wgsl',
      variants: {},
      capabilities: []
    });
    expect(result).toMatchObject({
      status: 'failed',
      diagnostics: [{ code: 'SHADER_SOURCE_RESOLVE' }]
    });
  });

  test('keeps last-known-good artifacts and prewarms explicit variants', async () => {
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/prewarm.flux': '@variant MODE: enum(a, b) = a;\n@vertex fn main() {}'
    });
    let fail = false;
    const compiler = new ShaderCompiler({
      resolver,
      validators: {
        wgsl: { validate: async () => (fail ? [{ line: 1, column: 1, message: 'bad' }] : []) }
      },
      versions: { compiler: 1, ir: 1, abi: 1, backend: 1 }
    });
    const base = {
      source: { uri: 'asset://shader/prewarm.flux', languageVersion: 1 },
      entries: ['main'],
      target: 'wgsl' as const,
      capabilities: []
    };
    const warmed = await compiler.prewarm([
      { ...base, revision: 1, variants: { MODE: 'a' } },
      { ...base, revision: 1, variants: { MODE: 'b' } }
    ]);
    expect(warmed.map((result) => result.status)).toEqual(['compiled', 'compiled']);
    fail = true;
    expect(
      (await compiler.compile({ ...base, revision: 2, variants: { MODE: 'a', UNKNOWN: true } }))
        .status
    ).toBe('failed');
    expect(compiler.lastKnownGood('asset://shader/prewarm.flux')).toBeDefined();
  });
});

function testTranslator(version: number): WebGL2ShaderTranslationPort {
  return {
    translatorId: 'compiler-test',
    version,
    translate: () => ({
      source: 'void main() {}',
      bindings: [],
      targetAbiFingerprint: 'test-abi',
      physicalBindings: [],
      requiredExtensions: [],
      sourceMap: [],
      translatorFingerprint: `output-${version}`
    })
  };
}
