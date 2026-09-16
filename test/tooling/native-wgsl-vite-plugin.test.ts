import { resolve } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import {
  nativeWgslPlugin,
  type NativeWgslPluginOptions
} from '../../tools/vite/native-wgsl-plugin';
import type { CookedShaderRuntimeArtifact } from '../../src/shader/types';
import type { NativeWgslCooker } from '../../tools/shader-cooker/native-wgsl-cooker';

const sampleArtifact: CookedShaderRuntimeArtifact = Object.freeze({
  schemaVersion: 2 as const,
  shaderManifestSchemaVersion: 1 as const,
  shaderModuleSchemaVersion: 2 as const,
  sourceKind: 'wgsl' as const,
  toolchain: Object.freeze({
    cookerId: 'aether-native-wgsl-cooker',
    cookerVersion: '0.0.0',
    nagaVersion: '30.0.0'
  }),
  source: Object.freeze({
    sourceUri: 'asset://test/fixtures/native-wgsl-plugin/simple.wgsl',
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
  bufferLayouts: Object.freeze([]),
  vertexInputs: Object.freeze([]),
  fragmentOutputs: Object.freeze([]),
  modules: Object.freeze({
    wgsl: '@vertex fn vertexMain() {}\n@fragment fn fragmentMain() {}',
    glslEs300: Object.freeze({
      'vertex:vertexMain': Object.freeze({
        source: '#version 300 es\nvoid main() {}',
        bindings: Object.freeze([])
      }),
      'fragment:fragmentMain': Object.freeze({
        source: '#version 300 es\nvoid main() {}',
        bindings: Object.freeze([])
      })
    })
  })
});

describe('nativeWgslPlugin for Vite', { timeout: 20000 }, () => {
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
      cook: vi.fn().mockImplementation(async (req: { sourceUri: string }) => ({
        ...sampleArtifact,
        source: { ...sampleArtifact.source, sourceUri: req.sourceUri }
      }))
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

  test('generates canonical URI relative to project root and rejects files escaping root', async () => {
    const mockCooker = {
      cook: vi.fn().mockImplementation(async (req: { sourceUri: string }) => ({
        ...sampleArtifact,
        source: { ...sampleArtifact.source, sourceUri: req.sourceUri }
      }))
    } as unknown as NativeWgslCooker;

    const rootDir = resolve(__dirname, '../..');
    const plugin = nativeWgslPlugin({ cooker: mockCooker, root: rootDir });
    const mockContext = { addWatchFile: vi.fn() };
    const virtualId = `\0aether-shader-artifact:${fixtureWgsl}`;

    // @ts-expect-error test hook call
    const code = await plugin.load.call(mockContext, virtualId);
    expect(code).toContain('asset://test/fixtures/native-wgsl-plugin/simple.wgsl');

    // Escaped file outside root should throw
    const escapedId = '\0aether-shader-artifact:/outside/root/shader.wgsl';
    // @ts-expect-error test hook call
    await expect(plugin.load.call(mockContext, escapedId)).rejects.toThrow(/escapes root/i);
  });

  test('correctly resolves root-level shader with relative import', async () => {
    const fixtureDir = resolve(__dirname, '../fixtures/native-wgsl-plugin');
    const rootLevelShader = resolve(fixtureDir, 'simple.wgsl');
    let capturedUri: string | undefined;
    const mockCooker = {
      cook: vi.fn().mockImplementation(async (req: { sourceUri: string }) => {
        capturedUri = req.sourceUri;
        return {
          ...sampleArtifact,
          source: { ...sampleArtifact.source, sourceUri: req.sourceUri }
        };
      })
    } as unknown as NativeWgslCooker;

    // Set plugin root to fixtureDir so simple.wgsl is directly at root
    const plugin = nativeWgslPlugin({ cooker: mockCooker, root: fixtureDir });
    const mockContext = { addWatchFile: vi.fn() };
    const virtualId = `\0aether-shader-artifact:${rootLevelShader}`;

    // @ts-expect-error test hook call
    const code = await plugin.load.call(mockContext, virtualId);
    expect(capturedUri).toBe('asset://project/simple.wgsl');
    expect(code).toContain('asset://project/simple.wgsl');
  });

  test('validates sidecar metadata and cross-checks with reflection during load', async () => {
    // Cooker reflecting a different entry point not matching metadata
    const mismatchedArtifact: CookedShaderRuntimeArtifact = {
      ...sampleArtifact,
      entryPoints: [
        {
          name: 'otherVertex',
          stage: 'vertex',
          bindings: []
        }
      ],
      modules: {
        wgsl: sampleArtifact.modules.wgsl,
        glslEs300: {
          'vertex:otherVertex': {
            source: '#version 300 es\nvoid main() {}',
            bindings: []
          }
        }
      }
    };

    const mockCooker = {
      cook: vi.fn().mockImplementation(async (req: { sourceUri: string }) => ({
        ...mismatchedArtifact,
        source: { ...mismatchedArtifact.source, sourceUri: req.sourceUri }
      }))
    } as unknown as NativeWgslCooker;

    const plugin = nativeWgslPlugin({ cooker: mockCooker });
    const mockContext = { addWatchFile: vi.fn() };
    const virtualId = `\0aether-shader-artifact:${fixtureWgsl}`;

    // Loading should fail because simple.wgsl.meta.json expects vertexMain & fragmentMain
    // @ts-expect-error test hook call
    await expect(plugin.load.call(mockContext, virtualId)).rejects.toThrow(
      /Metadata entry point "vertexMain" is not present in native reflection/i
    );
  });

  test('HMR retains last-known-good artifact when cook fails', async () => {
    let shouldFail = false;
    const mockCooker = {
      cook: vi.fn().mockImplementation(async (req: { sourceUri: string }) => {
        if (shouldFail) {
          throw new Error('Parse error in WGSL');
        }
        return {
          ...sampleArtifact,
          source: { ...sampleArtifact.source, sourceUri: req.sourceUri }
        };
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

    let cookCount = 0;
    const mockCooker = {
      cook: vi.fn().mockImplementation(async (req: { sourceUri: string }) => {
        cookCount++;
        if (cookCount === 1) return firstCookPromise;
        return {
          ...sampleArtifact,
          source: {
            ...sampleArtifact.source,
            sourceUri: req.sourceUri,
            contentHash: '0000000000000000000000000000000000000000000000000000000000000002'
          }
        };
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
    expect(code2).toContain('0000000000000000000000000000000000000000000000000000000000000002');

    // Complete first load afterwards
    resolveFirstCook(sampleArtifact);
    await load1Promise;

    // Load again should return newer artifact, not stale first artifact
    // @ts-expect-error test hook call
    const codeFinal = await plugin.load.call(mockContext, virtualId);
    expect(codeFinal).toContain('0000000000000000000000000000000000000000000000000000000000000002');
  });

  test('stale successful HMR completion does not invalidate after a newer revision publishes', async () => {
    let resolveFirstCook: (artifact: CookedShaderRuntimeArtifact) => void = () => {};
    const firstCook = new Promise<CookedShaderRuntimeArtifact>((resolveCook) => {
      resolveFirstCook = resolveCook;
    });
    let cookCount = 0;
    const mockCooker = {
      cook: vi.fn().mockImplementation(async () => {
        cookCount += 1;
        if (cookCount === 1) return firstCook;
        return sampleArtifact;
      })
    } as unknown as NativeWgslCooker;
    const plugin = nativeWgslPlugin({ cooker: mockCooker });
    const mockModule = { id: `\0aether-shader-artifact:${fixtureWgsl}` };
    const invalidateModule = vi.fn();
    const mockServer = {
      moduleGraph: {
        getModuleById: vi.fn().mockReturnValue(mockModule),
        invalidateModule
      },
      config: { logger: { error: vi.fn() } }
    };
    const context = { file: fixtureWgsl, server: mockServer, modules: [mockModule] };

    // @ts-expect-error test hook call
    const staleUpdate = plugin.handleHotUpdate(context);
    // @ts-expect-error test hook call
    const currentUpdate = plugin.handleHotUpdate(context);

    await expect(currentUpdate).resolves.toEqual([mockModule]);
    resolveFirstCook(sampleArtifact);
    await expect(staleUpdate).resolves.toEqual([]);
    expect(invalidateModule).toHaveBeenCalledTimes(1);
  });

  test('stale failed HMR completion does not report an obsolete diagnostic', async () => {
    let rejectFirstCook: (error: Error) => void = () => {};
    const firstCook = new Promise<CookedShaderRuntimeArtifact>((_resolveCook, rejectCook) => {
      rejectFirstCook = rejectCook;
    });
    let cookCount = 0;
    const mockCooker = {
      cook: vi.fn().mockImplementation(async () => {
        cookCount += 1;
        if (cookCount === 1) return firstCook;
        return sampleArtifact;
      })
    } as unknown as NativeWgslCooker;
    const plugin = nativeWgslPlugin({ cooker: mockCooker });
    const mockModule = { id: `\0aether-shader-artifact:${fixtureWgsl}` };
    const logger = { error: vi.fn() };
    const mockServer = {
      moduleGraph: {
        getModuleById: vi.fn().mockReturnValue(mockModule),
        invalidateModule: vi.fn()
      },
      config: { logger }
    };
    const context = { file: fixtureWgsl, server: mockServer, modules: [mockModule] };

    // @ts-expect-error test hook call
    const staleUpdate = plugin.handleHotUpdate(context);
    // @ts-expect-error test hook call
    await plugin.handleHotUpdate(context);
    rejectFirstCook(new Error('obsolete parse error'));
    await expect(staleUpdate).resolves.toEqual([]);
    expect(logger.error).not.toHaveBeenCalled();
  });

  test('runs programmatic Vite build and outputs pure artifact with no compiler/tooling symbols', async () => {
    const { build } = await import('vite');
    const fixtureDir = resolve(__dirname, '../fixtures/native-wgsl-plugin');
    const mockCooker = {
      cook: vi.fn().mockImplementation(async (req: { sourceUri: string }) => ({
        ...sampleArtifact,
        source: { ...sampleArtifact.source, sourceUri: req.sourceUri }
      }))
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
