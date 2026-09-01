import { describe, expect, test, vi } from 'vitest';
import { cookAuthoredShader } from '../../tools/shader-cooker/authoring-dispatch';
import { loadWgslMetadata } from '../../tools/shader-cooker/metadata-loader';
import { defineShaderAuthoringSource } from '../../src/shader/authoring';
import type { CookedShaderRuntimeArtifact, WgslShaderMetadata } from '../../src/shader/types';
import type { NativeWgslCooker } from '../../tools/shader-cooker/native-wgsl-cooker';

const sampleValidArtifact: CookedShaderRuntimeArtifact = Object.freeze({
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
  modules: Object.freeze({
    wgsl: '@vertex\nfn vertexMain() {}\n@fragment\nfn fragmentMain() {}',
    glslEs300: Object.freeze({
      'vertex:vertexMain': '#version 300 es\nvoid main() {}',
      'fragment:fragmentMain': '#version 300 es\nvoid main() {}'
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
});
