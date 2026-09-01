import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  nativeWgslPlugin,
  type NativeWgslPluginOptions
} from '../../tools/vite/native-wgsl-plugin';
import type { CookedShaderRuntimeArtifact } from '../../src/shader/types';
import type { NativeWgslCooker } from '../../tools/shader-cooker/native-wgsl-cooker';

const sampleArtifact: CookedShaderRuntimeArtifact = Object.freeze({
  schemaVersion: 1 as const,
  shaderManifestSchemaVersion: 1 as const,
  shaderModuleSchemaVersion: 1 as const,
  sourceKind: 'wgsl' as const,
  toolchain: Object.freeze({
    cookerId: 'aether-native-wgsl-cooker',
    cookerVersion: '0.0.0',
    nagaVersion: '30.0.0'
  }),
  source: Object.freeze({
    sourceUri: 'asset://shaders/simple.wgsl',
    contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    byteLength: 200
  }),
  entryPoints: Object.freeze([
    Object.freeze({
      name: 'vertexMain',
      stage: 'vertex' as const,
      bindings: Object.freeze([])
    }),
    Object.freeze({
      name: 'fragmentMain',
      stage: 'fragment' as const,
      bindings: Object.freeze([])
    })
  ]),
  bindings: Object.freeze([]),
  modules: Object.freeze({
    wgsl: '@vertex fn vertexMain() {}\n@fragment fn fragmentMain() {}',
    glslEs300: Object.freeze({
      'vertex:vertexMain': '#version 300 es\nvoid main() {}',
      'fragment:fragmentMain': '#version 300 es\nvoid main() {}'
    })
  })
});

describe('nativeWgslPlugin for Vite', () => {
  const fixtureWgsl = resolve(__dirname, '../fixtures/native-wgsl-plugin/simple.wgsl');

  test('does not hijack ordinary .wgsl imports without ?shader-artifact', () => {
    const plugin = nativeWgslPlugin();
    // @ts-expect-error test hook call
    const result = plugin.resolveId.call({}, './simple.wgsl', '/workspace/app.ts');
    expect(result).toBeNull();
  });

  test('resolves .wgsl?shader-artifact into virtual artifact module ID', () => {
    const plugin = nativeWgslPlugin();
    // @ts-expect-error test hook call
    const result = plugin.resolveId.call({}, './simple.wgsl?shader-artifact', fixtureWgsl);
    expect(result).toBe(`\0aether-shader-artifact:${fixtureWgsl}`);
  });

  test('loads virtual module, calls cooker, watches dependencies, and emits artifact literal', async () => {
    const mockCooker = {
      cook: vi.fn().mockResolvedValue(sampleArtifact)
    } as unknown as NativeWgslCooker;

    const plugin = nativeWgslPlugin({ cooker: mockCooker });
    const watchedFiles: string[] = [];
    const mockContext = {
      addWatchFile: (file: string) => watchedFiles.push(file)
    };

    const virtualId = `\0aether-shader-artifact:${fixtureWgsl}`;
    // @ts-expect-error test hook call
    const code = await plugin.load.call(mockContext, virtualId);

    expect(mockCooker.cook).toHaveBeenCalledTimes(1);
    expect(watchedFiles).toContain(fixtureWgsl);
    expect(code).toContain('export const artifact =');
    expect(code).toContain('export default artifact;');
    expect(code).not.toContain('node:child_process');
    expect(code).not.toContain('Cargo.toml');
  });

  test('HMR retains last-known-good artifact when cook fails', async () => {
    let shouldFail = false;
    const mockCooker = {
      cook: vi.fn().mockImplementation(async () => {
        if (shouldFail) {
          throw new Error('Parse error in WGSL');
        }
        return sampleArtifact;
      })
    } as unknown as NativeWgslCooker;

    const plugin = nativeWgslPlugin({ cooker: mockCooker });
    const mockContext = { addWatchFile: vi.fn() };
    const virtualId = `\0aether-shader-artifact:${fixtureWgsl}`;

    // Initial successful load
    // @ts-expect-error test hook call
    await plugin.load.call(mockContext, virtualId);

    // Now HMR update with syntax error
    shouldFail = true;
    const mockModule = { id: virtualId };
    const mockServer = {
      moduleGraph: {
        getModuleById: vi.fn().mockReturnValue(mockModule)
      },
      config: { logger: { error: vi.fn() } }
    };

    // @ts-expect-error test hook call
    const hmrModules = await plugin.handleHotUpdate({
      file: fixtureWgsl,
      server: mockServer,
      modules: [mockModule]
    });

    expect(hmrModules).toEqual([]);
    expect(mockServer.config.logger.error).toHaveBeenCalled();

    // Subsequent load still serves the last-known-good artifact
    // @ts-expect-error test hook call
    const cachedCode = await plugin.load.call(mockContext, virtualId);
    expect(cachedCode).toContain('export const artifact =');
  });

  test('stale async completion is rejected and cannot overwrite newer state', async () => {
    let resolveFirstCook: (artifact: CookedShaderRuntimeArtifact) => void = () => {};
    const firstCookPromise = new Promise<CookedShaderRuntimeArtifact>((res) => {
      resolveFirstCook = res;
    });

    const secondArtifact: CookedShaderRuntimeArtifact = {
      ...sampleArtifact,
      source: { ...sampleArtifact.source, contentHash: 'newer_hash' }
    };

    let cookCount = 0;
    const mockCooker = {
      cook: vi.fn().mockImplementation(async () => {
        cookCount++;
        if (cookCount === 1) return firstCookPromise;
        return secondArtifact;
      })
    } as unknown as NativeWgslCooker;

    const plugin = nativeWgslPlugin({ cooker: mockCooker });
    const mockContext = { addWatchFile: vi.fn() };
    const virtualId = `\0aether-shader-artifact:${fixtureWgsl}`;

    // Start first load (slow)
    // @ts-expect-error test hook call
    const load1Promise = plugin.load.call(mockContext, virtualId);

    // Start second load (faster)
    // @ts-expect-error test hook call
    const load2Promise = plugin.load.call(mockContext, virtualId);

    const code2 = await load2Promise;
    expect(code2).toContain('newer_hash');

    // Complete first load afterwards
    resolveFirstCook(sampleArtifact);
    await load1Promise;

    // Load again should return newer artifact, not stale first artifact
    // @ts-expect-error test hook call
    const codeFinal = await plugin.load.call(mockContext, virtualId);
    expect(codeFinal).toContain('newer_hash');
  });

  test('runs programmatic Vite build and outputs pure artifact with no compiler/tooling symbols', async () => {
    const { build } = await import('vite');
    const fixtureDir = resolve(__dirname, '../fixtures/native-wgsl-plugin');
    const mockCooker = {
      cook: vi.fn().mockResolvedValue(sampleArtifact)
    } as unknown as NativeWgslCooker;

    const buildOutput = await build({
      root: fixtureDir,
      plugins: [nativeWgslPlugin({ cooker: mockCooker })],
      build: {
        write: false,
        lib: {
          entry: resolve(fixtureDir, 'entry.ts'),
          formats: ['es'],
          fileName: () => 'bundle.js'
        },
        rollupOptions: {
          external: []
        }
      },
      logLevel: 'silent'
    });

    const outputChunk = Array.isArray(buildOutput)
      ? buildOutput[0]?.output[0]
      : 'output' in buildOutput
        ? buildOutput.output[0]
        : undefined;

    expect(outputChunk).toBeDefined();
    const code = (outputChunk as { code: string }).code;

    expect(code).toContain('vertexMain');
    expect(code).toContain('fragmentMain');
    expect(code).not.toContain('node:child_process');
    expect(code).not.toContain('Cargo.toml');
    expect(code).not.toContain('naga.wasm');
    expect(code).not.toContain('@naga/wasm');
    expect(code).not.toContain('src/shader/frontend');
  });
});
