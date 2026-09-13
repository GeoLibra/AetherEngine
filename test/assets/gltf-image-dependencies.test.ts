import { describe, expect, it } from 'vitest';
import { GltfImporter } from '../../src/assets/importers/gltf';
import { InMemoryDiagnosticSink } from '../../src/assets/importer/diagnostics';
import { StandardImportBudget } from '../../src/assets/importer/budget';
import type { AssetImportContext, AssetDependencyResolver } from '../../src/assets/importer/types';
import { VirtualFileSystem } from '../../src/assets/vfs';

function createMockContext(
  overrides: {
    dependencies?: Partial<AssetDependencyResolver>;
  } = {}
): AssetImportContext {
  const diagnostics = new InMemoryDiagnosticSink();
  const budget = new StandardImportBudget();
  const controller = new AbortController();
  const vfs = new VirtualFileSystem();

  const dependencies: AssetDependencyResolver = {
    resolve: (parent, rel) => overrides.dependencies?.resolve?.(parent, rel) ?? `${parent}/${rel}`,
    load: async (uri, sig) => {
      if (overrides.dependencies?.load) return overrides.dependencies.load(uri, sig);
      throw new Error(`Dependency not found: ${uri}`);
    }
  };

  return { vfs, signal: controller.signal, budget, diagnostics, dependencies };
}

describe('glTF external images, data URIs and default samplers', () => {
  it('loads external image dependencies via context.dependencies.load', async () => {
    const gltfJson = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0 }],
      meshes: [
        {
          primitives: [
            {
              attributes: {
                POSITION: 0
              },
              material: 0
            }
          ]
        }
      ],
      accessors: [
        {
          bufferView: 0,
          componentType: 5126,
          count: 3,
          type: 'VEC3',
          max: [1, 1, 0],
          min: [0, 0, 0]
        }
      ],
      bufferViews: [
        {
          buffer: 0,
          byteLength: 36
        }
      ],
      buffers: [
        {
          uri:
            'data:application/octet-stream;base64,' +
            Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).toString('base64'),
          byteLength: 36
        }
      ],
      materials: [
        {
          pbrMetallicRoughness: {
            baseColorTexture: { index: 0 }
          }
        }
      ],
      textures: [{ source: 0 }],
      images: [{ uri: 'textures/albedo.png', mimeType: 'image/png' }]
    };

    const mockPngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const loadedUris: string[] = [];

    const context = createMockContext({
      dependencies: {
        resolve: (parent, rel) => `models/${rel}`,
        load: async (uri) => {
          loadedUris.push(uri);
          return mockPngBytes;
        }
      }
    });

    const importer = new GltfImporter();
    const result = await importer.import(
      {
        uri: 'models/scene.gltf',
        kind: 'buffer',
        buffer: new TextEncoder().encode(JSON.stringify(gltfJson))
      },
      context
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success' && result.bundle) {
      expect(loadedUris).toContain('models/textures/albedo.png');
      expect(result.bundle.textures).toHaveLength(1);
      const tex = result.bundle.textures[0]!;
      expect(tex.uri).toBe('models/textures/albedo.png');
      expect(tex.data).toBeDefined();
      expect(tex.data!.byteLength).toBe(mockPngBytes.byteLength);

      // Verify glTF default sampler was emitted and assigned
      expect(result.bundle.samplers.some((s) => s.id.endsWith(':sampler:default'))).toBe(true);
      const defaultSampler = result.bundle.samplers.find((s) => s.id.endsWith(':sampler:default'));
      expect(defaultSampler).toBeDefined();
      expect(defaultSampler!.wrapS).toBe('repeat');
      expect(defaultSampler!.wrapT).toBe('repeat');
      expect(defaultSampler!.magFilter).toBe('linear');
      expect(defaultSampler!.minFilter).toBe('linear');

      const mat = result.bundle.materials[0]!;
      expect(mat.baseColorTexture?.samplerId).toBe(defaultSampler!.id);
    }
  });

  it('decodes inline data: URIs for embedded images', async () => {
    const rawImageBytes = new Uint8Array([1, 2, 3, 4, 5, 6]);
    const base64Data = Buffer.from(rawImageBytes).toString('base64');
    const gltfJson = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [] }],
      textures: [{ source: 0 }],
      images: [
        {
          uri: `data:image/png;base64,${base64Data}`
        }
      ]
    };

    const context = createMockContext();
    const importer = new GltfImporter();
    const result = await importer.import(
      {
        uri: 'inline.gltf',
        kind: 'buffer',
        buffer: new TextEncoder().encode(JSON.stringify(gltfJson))
      },
      context
    );

    expect(result.kind).toBe('success');
    if (result.kind === 'success' && result.bundle) {
      expect(result.bundle.textures).toHaveLength(1);
      const tex = result.bundle.textures[0]!;
      expect(tex.data).toBeDefined();
      expect(Array.from(tex.data!)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(tex.mimeType).toBe('image/png');
    }
  });

  it('fails fast with dependency-not-found when an external image cannot be loaded', async () => {
    const gltfJson = {
      asset: { version: '2.0' },
      scenes: [{ nodes: [] }],
      textures: [{ source: 0 }],
      images: [{ uri: 'textures/missing.png' }]
    };

    const context = createMockContext({
      dependencies: {
        resolve: (parent, rel) => `models/${rel}`,
        load: async (uri) => {
          throw new Error(`File not found: ${uri}`);
        }
      }
    });

    const importer = new GltfImporter();
    const result = await importer.import(
      {
        uri: 'models/scene.gltf',
        kind: 'buffer',
        buffer: new TextEncoder().encode(JSON.stringify(gltfJson))
      },
      context
    );

    expect(result.kind).toBe('failure');
    if (result.kind === 'failure') {
      expect(result.failure.code).toBe('dependency-not-found');
      expect(result.failure.message).toContain('Failed to load external image');
    }
  });
});
