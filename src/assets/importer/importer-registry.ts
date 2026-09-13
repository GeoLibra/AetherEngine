import type { CanonicalAssetDocument } from '../canonical/types';
import type {
  AssetImporter,
  AssetImporterDescriptor,
  AssetImporterId,
  AssetProbe,
  AssetProbeContext,
  AssetSource
} from './types';

export type ImporterSelectionResult =
  | { readonly kind: 'match'; readonly importer: AssetImporter<CanonicalAssetDocument> }
  | { readonly kind: 'ambiguous'; readonly candidates: readonly AssetImporterId[] }
  | { readonly kind: 'none' };

/**
 * Central registry for asset format importers with cascading format resolution.
 */
export class AssetImporterRegistry {
  private readonly descriptors: AssetImporterDescriptor[] = [];

  register(descriptor: AssetImporterDescriptor): void {
    if (this.descriptors.some((d) => d.importer.id === descriptor.importer.id)) {
      throw new Error(`Asset importer with id "${descriptor.importer.id}" is already registered.`);
    }
    this.descriptors.push(Object.freeze({ ...descriptor }));
    // Keep sorted by priority descending
    this.descriptors.sort((a, b) => b.priority - a.priority);
  }

  getImporter(id: AssetImporterId): AssetImporter<CanonicalAssetDocument> | undefined {
    return this.descriptors.find((d) => d.importer.id === id)?.importer;
  }

  /**
   * Resolves the appropriate importer using the 5-step cascade:
   * 1. Explicit importer ID
   * 2. Trusted MIME type
   * 3. File magic signature
   * 4. File extension
   * 5. Probe
   */
  async resolve(
    source: AssetSource,
    probeSlice?: AssetProbe,
    context?: AssetProbeContext
  ): Promise<ImporterSelectionResult> {
    // 1. Explicit importer handled by caller if specified, or if source specifies it in metadata

    // 2. MIME type matching
    if (source.mimeType) {
      const normalizedMime = source.mimeType.toLowerCase();
      const mimeMatches = this.descriptors.filter((d) =>
        d.mimeTypes.some((m) => m.toLowerCase() === normalizedMime)
      );
      const res = this.resolveMatches(mimeMatches);
      if (res.kind !== 'none') return res;
    }

    // 3. Magic signature matching
    const headerBytes = probeSlice?.headerBytes ?? source.buffer;
    if (headerBytes && headerBytes.length > 0) {
      const magicMatches = this.descriptors.filter((d) =>
        d.magicSignatures.some((sig) => matchesMagic(headerBytes, sig))
      );
      const res = this.resolveMatches(magicMatches);
      if (res.kind !== 'none') return res;
    }

    // 4. File extension matching
    const ext = source.extension ?? extractExtension(source.uri);
    if (ext) {
      const normalizedExt = ext.toLowerCase().replace(/^\./, '');
      const extMatches = this.descriptors.filter((d) =>
        d.extensions.some((e) => e.toLowerCase().replace(/^\./, '') === normalizedExt)
      );
      const res = this.resolveMatches(extMatches);
      if (res.kind !== 'none') return res;
    }

    // 5. Probe matching
    if (probeSlice && context) {
      const probeCandidates: {
        importer: AssetImporter<CanonicalAssetDocument>;
        confidence: number;
      }[] = [];
      for (const desc of this.descriptors) {
        const probeRes = await desc.importer.probe(probeSlice, context);
        if (probeRes.match) {
          probeCandidates.push({ importer: desc.importer, confidence: probeRes.confidence });
        }
      }

      if (probeCandidates.length === 1) {
        return { kind: 'match', importer: probeCandidates[0]!.importer };
      }
      if (probeCandidates.length > 1) {
        // Sort by confidence descending
        probeCandidates.sort((a, b) => b.confidence - a.confidence);
        if (probeCandidates[0]!.confidence > probeCandidates[1]!.confidence) {
          return { kind: 'match', importer: probeCandidates[0]!.importer };
        }
        return {
          kind: 'ambiguous',
          candidates: probeCandidates.map((c) => c.importer.id)
        };
      }
    }

    return { kind: 'none' };
  }

  private resolveMatches(matches: readonly AssetImporterDescriptor[]): ImporterSelectionResult {
    if (matches.length === 0) return { kind: 'none' };
    if (matches.length === 1) {
      return { kind: 'match', importer: matches[0]!.importer };
    }
    // Check if highest priority is unique
    const topPriority = matches[0]!.priority;
    const topMatches = matches.filter((m) => m.priority === topPriority);
    if (topMatches.length === 1) {
      return { kind: 'match', importer: topMatches[0]!.importer };
    }
    return {
      kind: 'ambiguous',
      candidates: topMatches.map((m) => m.importer.id)
    };
  }
}

function matchesMagic(
  buffer: Uint8Array,
  sig: { readonly offset: number; readonly bytes: readonly number[] }
): boolean {
  if (buffer.length < sig.offset + sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i += 1) {
    if (buffer[sig.offset + i] !== sig.bytes[i]) return false;
  }
  return true;
}

function extractExtension(uri: string): string | undefined {
  const clean = uri.split('?')[0]!.split('#')[0]!;
  const lastDot = clean.lastIndexOf('.');
  if (lastDot === -1 || lastDot === clean.length - 1) return undefined;
  return clean.substring(lastDot + 1);
}
