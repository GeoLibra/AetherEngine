import { sha256Hex } from '../../vfs';
import type { CanonicalSceneDocument } from '../../canonical/types';
import type {
  AssetDependency,
  AssetImportContext,
  AssetImporter,
  AssetImportFailureCode,
  AssetImportResult,
  AssetProbe,
  AssetProbeContext,
  AssetProbeResult,
  AssetSource
} from '../../importer/types';
import { decodeDataUri, parseGlbContainer, parseGltfJson } from './gltf-raw-parser';
import { adaptGltfToCanonical } from './gltf-scene-adapter';

const GLB_MAGIC_BYTES = [0x67, 0x6c, 0x54, 0x46]; // 'glTF' in little-endian

/**
 * Creates a unique, collision-resistant asset prefix for a glTF resource.
 * Incorporates a human-readable stem and a 256-bit SHA-256 cryptographic digest of the full URI.
 */
export function createGltfAssetPrefix(uri: string): string {
  const hash = sha256Hex(uri);
  const lastSegment = uri.split(/[/]/).pop() ?? '';
  const stem = lastSegment.replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return stem ? `gltf:${stem}:${hash}` : `gltf:${hash}`;
}

/**
 * Standard glTF 2.0 importer implementing probe and import for .gltf and .glb assets.
 */
export class GltfImporter implements AssetImporter<CanonicalSceneDocument> {
  readonly id = 'aether.importer.gltf';
  readonly version = '1.0.0';
  readonly acceptedKinds = Object.freeze(['file', 'buffer'] as const);
  readonly outputKinds = Object.freeze([
    'scene',
    'mesh',
    'material',
    'texture',
    'sampler'
  ] as const);

  async probe(source: AssetProbe, _context: AssetProbeContext): Promise<AssetProbeResult> {
    const bytes = source.headerBytes;
    if (bytes.length >= 4) {
      if (
        bytes[0] === GLB_MAGIC_BYTES[0] &&
        bytes[1] === GLB_MAGIC_BYTES[1] &&
        bytes[2] === GLB_MAGIC_BYTES[2] &&
        bytes[3] === GLB_MAGIC_BYTES[3]
      ) {
        return { match: true, confidence: 1.0, estimatedKind: 'scene' };
      }
    }

    if (source.declaredMimeType === 'model/gltf+json' || source.declaredExtension === 'gltf') {
      return { match: true, confidence: 0.9, estimatedKind: 'scene' };
    }

    if (source.declaredMimeType === 'model/gltf-binary' || source.declaredExtension === 'glb') {
      return { match: true, confidence: 0.9, estimatedKind: 'scene' };
    }

    // Try text sniffing for "asset" and "version" in first bytes
    try {
      const text = new TextDecoder('utf-8').decode(bytes.slice(0, 256));
      if (text.includes('"asset"') && text.includes('version')) {
        return { match: true, confidence: 0.8, estimatedKind: 'scene' };
      }
    } catch {
      // Non-text
    }

    return { match: false };
  }

  async import(
    source: AssetSource,
    context: AssetImportContext
  ): Promise<AssetImportResult<CanonicalSceneDocument>> {
    const uri = source.uri;

    if (context.signal.aborted) {
      return this.failureResult('cancelled', 'Import aborted by signal.', uri, context);
    }

    try {
      // 1. Acquire raw buffer
      const buffer = source.buffer ?? (await context.dependencies.load(uri, context.signal));
      context.budget.recordRead(buffer.byteLength);

      const hasGlbMagic =
        buffer.length >= 4 &&
        buffer[0] === GLB_MAGIC_BYTES[0] &&
        buffer[1] === GLB_MAGIC_BYTES[1] &&
        buffer[2] === GLB_MAGIC_BYTES[2] &&
        buffer[3] === GLB_MAGIC_BYTES[3];

      const isGlb =
        hasGlbMagic ||
        source.mimeType === 'model/gltf-binary' ||
        source.extension === 'glb' ||
        uri.toLowerCase().endsWith('.glb');

      let rawContainer;
      const dependencies: AssetDependency[] = [];

      if (isGlb) {
        rawContainer = parseGlbContainer(buffer);
      } else {
        const text = new TextDecoder('utf-8').decode(buffer);
        const parsedJson = JSON.parse(text);

        // Resolve external buffers
        const buffers: Uint8Array[] = [];
        if (Array.isArray(parsedJson.buffers)) {
          for (let i = 0; i < parsedJson.buffers.length; i += 1) {
            const bufDesc = parsedJson.buffers[i];
            if (bufDesc.uri) {
              if (bufDesc.uri.startsWith('data:')) {
                const decoded = decodeDataUri(bufDesc.uri, context.budget);
                context.budget.recordRead(decoded.data.byteLength);
                buffers.push(decoded.data);
              } else {
                const resolvedUri = context.dependencies.resolve(uri, bufDesc.uri);
                dependencies.push({ uri: resolvedUri, kind: 'buffer', required: true });
                const bufData = await context.dependencies.load(resolvedUri, context.signal);
                context.budget.recordRead(bufData.byteLength);
                buffers.push(bufData);
              }
            }
          }
        }
        rawContainer = parseGltfJson(text, buffers);
      }

      // Resolve and load image dependencies
      const resolvedImages = new Map<
        number,
        { data?: Uint8Array; uri?: string; mimeType?: string }
      >();
      if (Array.isArray(rawContainer.json.images)) {
        for (let i = 0; i < rawContainer.json.images.length; i += 1) {
          const img = rawContainer.json.images[i];
          if (!img) continue;
          if (img.uri) {
            if (img.uri.startsWith('data:')) {
              const decoded = decodeDataUri(img.uri, context.budget);
              context.budget.recordRead(decoded.data.byteLength);
              resolvedImages.set(i, {
                data: decoded.data,
                mimeType: decoded.mimeType ?? img.mimeType
              });
            } else {
              const resolvedUri = context.dependencies.resolve(uri, img.uri);
              dependencies.push({ uri: resolvedUri, kind: 'image', required: true });
              try {
                const imgBytes = await context.dependencies.load(resolvedUri, context.signal);
                context.budget.recordRead(imgBytes.byteLength);
                resolvedImages.set(i, {
                  data: imgBytes,
                  uri: resolvedUri,
                  mimeType: img.mimeType
                });
              } catch (loadErr) {
                return this.failureResult(
                  'dependency-not-found',
                  `Failed to load external image "${img.uri}" (resolved "${resolvedUri}"): ${(loadErr as Error).message}`,
                  uri,
                  context
                );
              }
            }
          }
        }
      }

      // 2. Adapt to canonical documents
      const bundle = adaptGltfToCanonical(rawContainer, {
        assetPrefix: createGltfAssetPrefix(uri),
        resolvedImages,
        budget: context.budget,
        diagnostics: context.diagnostics
      });

      return Object.freeze({
        kind: 'success' as const,
        document: bundle.scene,
        bundle,
        documents: Object.freeze([
          bundle.scene,
          ...bundle.meshes,
          ...bundle.materials,
          ...bundle.textures,
          ...bundle.samplers
        ]),
        dependencies: Object.freeze(dependencies),
        diagnostics: context.diagnostics.getDiagnostics(),
        statistics: bundle.statistics
      });
    } catch (error) {
      const err = error as Error;
      if (context.signal.aborted) {
        return this.failureResult('cancelled', 'Import aborted by signal.', uri, context);
      }
      if (err.message.includes('unsupported extension')) {
        return this.failureResult('unsupported-required-extension', err.message, uri, context);
      }
      if (
        err.message.includes('budget exceeded') ||
        err.message.includes('Allocation budget exceeded')
      ) {
        return this.failureResult('size-limit-exceeded', err.message, uri, context);
      }
      if (err.message.includes('Invalid GLB magic')) {
        return this.failureResult('invalid-magic', err.message, uri, context);
      }
      if (err.message.includes('Unsupported UV set index')) {
        return this.failureResult('unsupported-profile', err.message, uri, context);
      }
      if (
        err.message.includes('Missing texture dependency') ||
        err.message.includes('Invalid texture index') ||
        err.message.includes('Invalid texture source') ||
        err.message.includes('Invalid mesh index') ||
        err.message.includes('references image')
      ) {
        return this.failureResult('dependency-not-found', err.message, uri, context);
      }
      return this.failureResult('unsupported-format', err.message, uri, context);
    }
  }

  private failureResult(
    code: AssetImportFailureCode,
    message: string,
    uri: string,
    context: AssetImportContext
  ): AssetImportResult<CanonicalSceneDocument> {
    context.diagnostics.report({
      severity: 'error',
      code: `asset.${code}`,
      message,
      targetUri: uri
    });
    return Object.freeze({
      kind: 'failure',
      failure: Object.freeze({
        code,
        message,
        uri
      }),
      diagnostics: context.diagnostics.getDiagnostics()
    });
  }
}
