import { describe, expect, test } from 'vitest';
import type { AssetId } from '../../src/assets/types';
import type {
  CookedMeshArtifact,
  CookedSceneArtifact,
  CookedTextureArtifact
} from '../../src/assets/cooker/types';
import { decodeCookedArtifact, encodeCookedArtifact } from '../../src/assets/cooker/artifact-codec';

describe('artifact codec', () => {
  test('encodes and decodes CookedMeshArtifact round-trip', () => {
    const meshArtifact: CookedMeshArtifact = {
      id: 'mesh.encoded.1' as AssetId,
      kind: 'mesh',
      version: 1,
      primitives: [],
      totalByteLength: 1024
    };

    const encoded = encodeCookedArtifact(meshArtifact);
    expect(encoded.byteLength).toBeGreaterThan(16);

    const decoded = decodeCookedArtifact(encoded) as CookedMeshArtifact;
    expect(decoded.id).toBe('mesh.encoded.1');
    expect(decoded.kind).toBe('mesh');
    expect(decoded.version).toBe(1);
    expect(decoded.totalByteLength).toBe(1024);
  });

  test('encodes and decodes CookedTextureArtifact with binary pixels', () => {
    const pixels = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255]);
    const texArtifact: CookedTextureArtifact = {
      id: 'tex.encoded.1' as AssetId,
      kind: 'texture',
      version: 2,
      role: 'base-color',
      semantic: 'color',
      format: 'rgba8unorm-srgb',
      width: 2,
      height: 1,
      data: pixels,
      mipCount: 1
    };

    const encoded = encodeCookedArtifact(texArtifact);
    const decoded = decodeCookedArtifact(encoded) as CookedTextureArtifact;

    expect(decoded.id).toBe('tex.encoded.1');
    expect(decoded.kind).toBe('texture');
    expect(decoded.version).toBe(2);
    expect(decoded.role).toBe('base-color');
    expect(decoded.semantic).toBe('color');
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(1);
    expect(Array.from(decoded.data)).toEqual(Array.from(pixels));
  });

  test('encodes and decodes CookedSceneArtifact', () => {
    const sceneArtifact: CookedSceneArtifact = {
      id: 'scene.encoded.1' as AssetId,
      kind: 'scene',
      version: 1,
      nodes: [
        {
          nodeIndex: 0,
          name: 'root',
          localTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          worldTransform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
          children: []
        }
      ],
      rootNodes: [0],
      defaultSceneIndex: 0
    };

    const encoded = encodeCookedArtifact(sceneArtifact);
    const decoded = decodeCookedArtifact(encoded) as CookedSceneArtifact;

    expect(decoded.id).toBe('scene.encoded.1');
    expect(decoded.kind).toBe('scene');
    expect(decoded.nodes).toHaveLength(1);
    expect(decoded.nodes[0]!.name).toBe('root');
  });

  test('throws on corrupted magic or truncated data', () => {
    expect(() => decodeCookedArtifact(new Uint8Array(10))).toThrow(/less than 16-byte header/);

    const corrupt = new Uint8Array(20);
    expect(() => decodeCookedArtifact(corrupt)).toThrow(/Invalid artifact magic/);
  });
});
