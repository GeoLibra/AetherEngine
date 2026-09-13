import { describe, expect, it } from 'vitest';
import {
  AssetImporterRegistry,
  type AssetImporter,
  type AssetProbe,
  type AssetProbeContext,
  type AssetProbeResult,
  type AssetSource,
  type AssetImportResult
} from '../../src/assets/importer';
import type { CanonicalAssetDocument } from '../../src/assets/canonical';

function createMockImporter(id: string): AssetImporter<CanonicalAssetDocument> {
  return {
    id,
    version: '1.0.0',
    acceptedKinds: ['file', 'buffer'],
    outputKinds: ['scene'],
    async probe(probe: AssetProbe, _context: AssetProbeContext): Promise<AssetProbeResult> {
      if (probe.declaredExtension === 'mock') {
        return { match: true, confidence: 0.9, estimatedKind: 'scene' };
      }
      return { match: false };
    },
    async import(
      _source: AssetSource,
      _context: any
    ): Promise<AssetImportResult<CanonicalAssetDocument>> {
      throw new Error('Not implemented in mock');
    }
  };
}

describe('AssetImporterRegistry', () => {
  it('selects importer by MIME type over extension when MIME is present', async () => {
    const registry = new AssetImporterRegistry();
    const importerA = createMockImporter('importer-a');
    const importerB = createMockImporter('importer-b');

    registry.register({
      importer: importerA,
      extensions: ['gltf'],
      mimeTypes: ['model/gltf+json'],
      magicSignatures: [],
      priority: 10
    });

    registry.register({
      importer: importerB,
      extensions: ['gltf'],
      mimeTypes: ['application/octet-stream'],
      magicSignatures: [],
      priority: 10
    });

    const result = await registry.resolve({
      uri: 'model.gltf',
      kind: 'file',
      mimeType: 'model/gltf+json'
    });

    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.importer.id).toBe('importer-a');
    }
  });

  it('selects importer by magic signature before file extension', async () => {
    const registry = new AssetImporterRegistry();
    const glbImporter = createMockImporter('glb-importer');
    const textImporter = createMockImporter('text-importer');

    // GLB magic: 0x46546C67 ('glTF')
    registry.register({
      importer: glbImporter,
      extensions: ['bin'],
      mimeTypes: [],
      magicSignatures: [{ offset: 0, bytes: [0x67, 0x6c, 0x54, 0x46] }],
      priority: 10
    });

    registry.register({
      importer: textImporter,
      extensions: ['bin'],
      mimeTypes: [],
      magicSignatures: [],
      priority: 10
    });

    // File named 'model.bin' but has GLB magic bytes
    const glbMagicBuffer = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);
    const result = await registry.resolve({
      uri: 'model.bin',
      kind: 'buffer',
      buffer: glbMagicBuffer
    });

    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.importer.id).toBe('glb-importer');
    }
  });

  it('returns ambiguous when two importers match with equal priority and no discriminating features', async () => {
    const registry = new AssetImporterRegistry();
    const importer1 = createMockImporter('importer-1');
    const importer2 = createMockImporter('importer-2');

    registry.register({
      importer: importer1,
      extensions: ['xyz'],
      mimeTypes: [],
      magicSignatures: [],
      priority: 10
    });

    registry.register({
      importer: importer2,
      extensions: ['xyz'],
      mimeTypes: [],
      magicSignatures: [],
      priority: 10
    });

    const result = await registry.resolve({
      uri: 'data.xyz',
      kind: 'file'
    });

    expect(result.kind).toBe('ambiguous');
    if (result.kind === 'ambiguous') {
      expect(result.candidates).toEqual(['importer-1', 'importer-2']);
    }
  });

  it('resolves tie using explicit priority setting', async () => {
    const registry = new AssetImporterRegistry();
    const standardImporter = createMockImporter('standard-importer');
    const overrideImporter = createMockImporter('override-importer');

    registry.register({
      importer: standardImporter,
      extensions: ['xyz'],
      mimeTypes: [],
      magicSignatures: [],
      priority: 10
    });

    registry.register({
      importer: overrideImporter,
      extensions: ['xyz'],
      mimeTypes: [],
      magicSignatures: [],
      priority: 100 // Higher priority
    });

    const result = await registry.resolve({
      uri: 'data.xyz',
      kind: 'file'
    });

    expect(result.kind).toBe('match');
    if (result.kind === 'match') {
      expect(result.importer.id).toBe('override-importer');
    }
  });
});
