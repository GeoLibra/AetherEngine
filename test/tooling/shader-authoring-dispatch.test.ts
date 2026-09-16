import { describe, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cookAuthoredShader } from '../../tools/shader-cooker/authoring-dispatch';
import { FileSystemShaderModuleLoader } from '../../tools/shader-cooker/modules';
import { loadWgslMetadata } from '../../tools/shader-cooker/metadata-loader';
import { defineShaderAuthoringSource } from '../../src/shader/authoring';
import type { CookedShaderRuntimeArtifact, WgslShaderMetadata } from '../../src/shader/types';
import type { NativeWgslCooker } from '../../tools/shader-cooker/native-wgsl-cooker';

const sampleValidArtifact: CookedShaderRuntimeArtifact = Object.freeze({
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
    sourceUri: 'asset://shaders/test.wgsl',
    contentHash: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    byteLength: 100
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
    wgsl: '@vertex\nfn vertexMain() {}\n@fragment\nfn fragmentMain() {}',
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

describe('loadWgslMetadata', () => {
  test('loads and validates valid sidecar metadata file', async () => {
    const validJson = JSON.stringify({
      schemaVersion: 1,
      entryPoints: [
        { name: 'vertexMain', stage: 'vertex' },
        { name: 'fragmentMain', stage: 'fragment' }
      ]
    });
    const mockFs = {
      readFile: vi.fn().mockResolvedValue(validJson)
    };

    const metadata = await loadWgslMetadata('/path/to/test.wgsl.meta.json', mockFs);
    expect(metadata.schemaVersion).toBe(1);
    expect(metadata.entryPoints).toHaveLength(2);
    expect(Object.isFrozen(metadata)).toBe(true);
  });

  test('rejects metadata with unknown fields or bad schema', async () => {
    const invalidJson = JSON.stringify({
      schemaVersion: 1,
      entryPoints: [{ name: 'main', stage: 'vertex' }],
      unsupportedKey: true
    });
    const mockFs = {
      readFile: vi.fn().mockResolvedValue(invalidJson)
    };

    await expect(loadWgslMetadata('/path/to/test.wgsl.meta.json', mockFs)).rejects.toThrow(
      /unknown metadata field/i
    );
  });
});

describe('cookAuthoredShader dispatch', () => {
  test('dispatches WGSL source to NativeWgslCooker and cross-checks metadata entry points', async () => {
    const mockCooker = {
      cook: vi.fn().mockResolvedValue(sampleValidArtifact)
    } as unknown as NativeWgslCooker;

    const source = defineShaderAuthoringSource({ uri: 'asset://shaders/test.wgsl' });
    const metadata: WgslShaderMetadata = {
      schemaVersion: 1,
      entryPoints: [
        { name: 'vertexMain', stage: 'vertex' },
        { name: 'fragmentMain', stage: 'fragment' }
      ]
    };

    const result = await cookAuthoredShader(
      {
        source,
        sourcePath: '/workspace/shaders/test.wgsl',
        metadata
      },
      { cooker: mockCooker }
    );

    expect(mockCooker.cook).toHaveBeenCalledTimes(1);
    expect(result).toEqual(sampleValidArtifact);
  });

  test('fails if metadata declares entry points missing in native reflection', async () => {
    const mockCooker = {
      cook: vi.fn().mockResolvedValue(sampleValidArtifact)
    } as unknown as NativeWgslCooker;

    const source = defineShaderAuthoringSource({ uri: 'asset://shaders/test.wgsl' });
    const metadata: WgslShaderMetadata = {
      schemaVersion: 1,
      entryPoints: [
        { name: 'vertexMain', stage: 'vertex' },
        { name: 'missingMain', stage: 'fragment' } // does not exist in sampleValidArtifact
      ]
    };

    await expect(
      cookAuthoredShader(
        {
          source,
          sourcePath: '/workspace/shaders/test.wgsl',
          metadata
        },
        { cooker: mockCooker }
      )
    ).rejects.toThrow(/metadata entry point "missingMain" is not present in native reflection/i);
  });

  test('rejects flux-experimental without explicit allowExperimentalFlux option', async () => {
    const source = defineShaderAuthoringSource({
      kind: 'flux-experimental',
      uri: 'package://engine/lit.flux'
    });

    await expect(
      cookAuthoredShader({
        source,
        sourcePath: '/workspace/lit.flux'
      })
    ).rejects.toThrow(/flux-experimental requires explicit opt-in/i);
  });

  test('allows flux-experimental when allowExperimentalFlux is true and delegates to flux adapter', async () => {
    const source = defineShaderAuthoringSource({
      kind: 'flux-experimental',
      uri: 'package://engine/lit.flux'
    });

    const mockFluxCooker = {
      cook: vi.fn().mockResolvedValue({
        ...sampleValidArtifact,
        sourceKind: 'flux-experimental' as const
      })
    };

    const result = await cookAuthoredShader(
      {
        source,
        sourcePath: '/workspace/lit.flux'
      },
      {
        allowExperimentalFlux: true,
        fluxCooker: mockFluxCooker
      }
    );

    expect(mockFluxCooker.cook).toHaveBeenCalledTimes(1);
    expect(result.sourceKind).toBe('flux-experimental');
  });

  test('rejects shader-graph with fail-fast unsupported error', async () => {
    const source = defineShaderAuthoringSource({
      kind: 'shader-graph',
      uri: 'asset://shaders/graph.json'
    });

    await expect(
      cookAuthoredShader({
        source,
        sourcePath: '/workspace/graph.json'
      })
    ).rejects.toThrow(/shader-graph authoring is not yet supported for cooking/i);
  });

  test('does not run layout diagnostics by default during normal WGSL cooking', async () => {
    const artifactWithGaps: CookedShaderRuntimeArtifact = {
      ...sampleValidArtifact,
      bufferLayouts: [
        {
          group: 0,
          binding: 0,
          name: 'PaddedData',
          byteSize: 32,
          alignment: 16,
          fields: [
            { path: 'a', offset: 0, size: 4, alignment: 4, typeName: 'f32' },
            { path: 'b', offset: 16, size: 16, alignment: 16, typeName: 'vec4<f32>' }
          ]
        }
      ]
    };

    const mockCooker = {
      cook: vi.fn().mockResolvedValue(artifactWithGaps)
    } as unknown as NativeWgslCooker;

    const source = defineShaderAuthoringSource({ uri: 'asset://shaders/test.wgsl' });
    const diagnosticCallback = vi.fn();
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {});

    await cookAuthoredShader(
      {
        source,
        sourcePath: '/workspace/shaders/test.wgsl'
      },
      {
        cooker: mockCooker,
        onLayoutDiagnostic: diagnosticCallback
      }
    );

    expect(diagnosticCallback).not.toHaveBeenCalled();
    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
  });

  test('runs layout diagnostics and passes to onLayoutDiagnostic when diagnoseLayout is true', async () => {
    const artifactWithGaps: CookedShaderRuntimeArtifact = {
      ...sampleValidArtifact,
      bufferLayouts: [
        {
          group: 0,
          binding: 0,
          name: 'PaddedData',
          byteSize: 32,
          alignment: 16,
          fields: [
            { path: 'a', offset: 0, size: 4, alignment: 4, typeName: 'f32' },
            { path: 'b', offset: 16, size: 16, alignment: 16, typeName: 'vec4<f32>' }
          ]
        }
      ]
    };

    const mockCooker = {
      cook: vi.fn().mockResolvedValue(artifactWithGaps)
    } as unknown as NativeWgslCooker;

    const source = defineShaderAuthoringSource({ uri: 'asset://shaders/test.wgsl' });
    const diagnosticCallback = vi.fn();

    await cookAuthoredShader(
      {
        source,
        sourcePath: '/workspace/shaders/test.wgsl'
      },
      {
        cooker: mockCooker,
        diagnoseLayout: true,
        onLayoutDiagnostic: diagnosticCallback
      }
    );

    expect(diagnosticCallback).toHaveBeenCalledTimes(1);
    expect(diagnosticCallback.mock.calls[0]?.[0]?.structName).toBe('PaddedData');
    expect(diagnosticCallback.mock.calls[0]?.[0]?.paddingBytes).toBe(12);
  });

  test('cooks external root with relative imports through a custom loader using root source override', async () => {
    const externalDir = resolve(__dirname, '../fixtures/native-wgsl-plugin/external');
    // Root file lives at a canonical URI whose authority maps to a directory containing only
    // the relative module (util.wgsl). The root must come from the sourcePath override, never
    // from the loader's authority-to-directory mapping.
    const externalRootPath = resolve(__dirname, '../fixtures/native-wgsl-plugin/simple.wgsl');
    let linkedSource: string | undefined;
    const mockCooker = {
      cook: vi.fn().mockImplementation(async (req: { sourcePath: string }) => {
        linkedSource = readFileSync(req.sourcePath, 'utf8');
        return sampleValidArtifact;
      })
    } as unknown as NativeWgslCooker;

    const source = defineShaderAuthoringSource({ uri: 'asset://vendor/root.wgsl' });
    const metadata: WgslShaderMetadata = {
      schemaVersion: 1,
      entryPoints: [
        { name: 'vertexMain', stage: 'vertex' },
        { name: 'fragmentMain', stage: 'fragment' }
      ],
      imports: [{ path: './util.wgsl' }]
    };

    const resolvedDeps: string[] = [];
    const result = await cookAuthoredShader(
      {
        source,
        sourcePath: externalRootPath,
        metadata
      },
      {
        cooker: mockCooker,
        moduleLoader: new FileSystemShaderModuleLoader({
          roots: { vendor: externalDir },
          projectRoot: externalDir
        }),
        onDependencyResolved: (depPath) => resolvedDeps.push(depPath)
      }
    );

    expect(result).toEqual(sampleValidArtifact);
    // Linked output must contain the root override source (a file NOT present under the vendor
    // authority) plus the relative import resolved from the mapped external directory. A missing
    // root or module would throw ERR_MODULE_NOT_FOUND.
    expect(linkedSource).toContain('fn vertexMain');
    expect(linkedSource).toContain('fn externalOffset');
    expect(resolvedDeps).toContain(externalRootPath);
    expect(resolvedDeps).toContain(resolve(externalDir, 'util.wgsl'));
  });
});
