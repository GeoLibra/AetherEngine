import { canonicalStringify, isRecord } from '../../core';
import type {
  DecodedRenderArtifactPackage,
  RenderArtifactEnvelope,
  RenderArtifactPackageInput,
  RenderArtifactPackageSectionInput,
  RenderArtifactReferenceBundle,
  RenderArtifactSectionIndex,
  RenderArtifactSectionKind
} from './types';

const REQUIRED_SHADER_LIBRARY_SECTIONS = Object.freeze([
  'manifest',
  'reflection',
  'layout-plans',
  'shader-module',
  'dependencies'
] as const satisfies readonly RenderArtifactSectionKind[]);
const REQUIRED_MATERIAL_SECTIONS = Object.freeze([
  'material-schema',
  'techniques',
  'variant-table'
] as const satisfies readonly RenderArtifactSectionKind[]);
const NON_SEMANTIC_SECTIONS = new Set<RenderArtifactSectionKind>([
  'source',
  'source-map',
  'debug-symbols'
]);
const UTF8 = new TextEncoder();
const HASH_PATTERN = /^[a-f0-9]{64}$/u;

/** Encodes the canonical JSON reference representation of one production render package. */
export async function encodeRenderArtifactPackage(
  input: RenderArtifactPackageInput
): Promise<RenderArtifactReferenceBundle> {
  validateInput(input);
  const sections = [...input.sections].sort(
    (left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id)
  );
  const indexed: RenderArtifactSectionIndex[] = [];
  const blobs = new Map<string, Uint8Array>();
  for (const section of sections) {
    const bytes = UTF8.encode(canonicalStringify(section.payload));
    const hash = await sha256(bytes);
    const blobId = `sha256:${hash}`;
    indexed.push(
      Object.freeze({
        id: section.id,
        kind: section.kind,
        uncompressedLength: bytes.byteLength,
        hash,
        required: section.required,
        ...(section.target === undefined ? {} : { target: freezeRecord(section.target) }),
        location: Object.freeze({ storage: 'external' as const, blobId })
      })
    );
    blobs.set(blobId, bytes);
  }
  const manifestSchemaVersion = input.manifestSchemaVersion ?? 1;
  const shaderManifestSchemaVersion = input.shaderManifestSchemaVersion ?? 1;
  const shaderModuleSchemaVersion = input.shaderModuleSchemaVersion ?? 2;
  const semanticHeader = {
    artifactKind: input.artifactKind,
    manifestSchemaVersion,
    shaderManifestSchemaVersion,
    shaderModuleSchemaVersion,
    shaderAbiVersion: input.shaderAbiVersion,
    ...(input.artifactKind === 'material'
      ? { materialSchemaVersion: input.materialSchemaVersion }
      : {}),
    toolchain: input.toolchain,
    shaderToolchain: input.shaderToolchain
  };
  const semanticContentHash = await semanticDigest(indexed, semanticHeader);
  const envelopeWithoutContainerHash = {
    magic: 'AERENDER' as const,
    artifactKind: input.artifactKind,
    containerVersion: (input.containerVersion ?? 1) as 1,
    manifestSchemaVersion: manifestSchemaVersion as 1,
    shaderManifestSchemaVersion: shaderManifestSchemaVersion as 1,
    shaderModuleSchemaVersion: shaderModuleSchemaVersion as 2,
    shaderAbiVersion: input.shaderAbiVersion,
    ...(input.artifactKind === 'material'
      ? { materialSchemaVersion: input.materialSchemaVersion }
      : {}),
    toolchain: input.toolchain,
    shaderToolchain: input.shaderToolchain,
    packageId: `render:${semanticContentHash}`,
    semanticContentHash,
    containerHash: '',
    sections: indexed
  };
  const containerHash = await containerDigest(envelopeWithoutContainerHash, blobs);
  return Object.freeze({
    manifest: canonicalStringify({
      envelope: { ...envelopeWithoutContainerHash, containerHash }
    }),
    blobs: copyBlobs(blobs)
  });
}

/** Validates and decodes the canonical JSON reference representation. */
export async function decodeRenderArtifactPackage(
  bundle: RenderArtifactReferenceBundle
): Promise<DecodedRenderArtifactPackage> {
  const blobs = copyBlobs(bundle.blobs);
  let raw: unknown;
  try {
    raw = JSON.parse(bundle.manifest);
  } catch {
    throw new Error('[container-invalid] Render artifact package must be valid JSON.');
  }
  if (!isRecord(raw) || !isRecord(raw.envelope)) {
    throw new Error('[container-invalid] Render artifact package envelope is missing.');
  }
  const envelope = raw.envelope as unknown as RenderArtifactEnvelope;
  if (envelope.magic !== 'AERENDER' || envelope.containerVersion !== 1) {
    throw new Error('[container-version-unsupported] Unsupported render artifact container.');
  }
  if (envelope.manifestSchemaVersion !== 1) {
    throw new Error(
      `[manifest-schema-version-unsupported] Expected manifestSchemaVersion 1, received ${String(envelope.manifestSchemaVersion)}.`
    );
  }
  if (envelope.shaderManifestSchemaVersion !== 1) {
    throw new Error(
      `[shader-manifest-schema-version-unsupported] Expected shaderManifestSchemaVersion 1, received ${String(envelope.shaderManifestSchemaVersion)}.`
    );
  }
  if (envelope.shaderModuleSchemaVersion !== 2) {
    throw new Error(
      `[shader-module-schema-version-unsupported] Expected shaderModuleSchemaVersion 2, received ${String(envelope.shaderModuleSchemaVersion)}.`
    );
  }
  if (!HASH_PATTERN.test(envelope.containerHash)) {
    throw new Error('[container-integrity-failed] Container hash is invalid.');
  }
  if (!Array.isArray(envelope.sections)) {
    throw new Error('[section-index-invalid] Render artifact section index is missing.');
  }
  for (const entry of envelope.sections) {
    if (entry.location?.storage !== 'external' || !entry.location.blobId) {
      throw new Error(`[section-index-invalid] Section "${entry.id}" has no external location.`);
    }
    if (!blobs.has(entry.location.blobId)) {
      throw new Error(
        `[external-blob-missing] Section "${entry.id}" blob "${entry.location.blobId}" is missing.`
      );
    }
  }
  const expectedContainerHash = await containerDigest({ ...envelope, containerHash: '' }, blobs);
  if (expectedContainerHash !== envelope.containerHash) {
    throw new Error('[container-integrity-failed] Container content does not match its hash.');
  }
  const sections: RenderArtifactPackageSectionInput[] = [];
  for (const entry of envelope.sections) {
    const location = entry.location;
    if (location.storage !== 'external') {
      throw new Error(`[section-index-invalid] Section "${entry.id}" is not externally stored.`);
    }
    const bytes = blobs.get(location.blobId)!;
    const hash = await sha256(bytes);
    if (entry.uncompressedLength !== bytes.byteLength || entry.hash !== hash) {
      throw new Error(`[section-integrity-failed] Section "${entry.id}" disagrees with its index.`);
    }
    let payload: unknown;
    const encodedPayload = new TextDecoder().decode(bytes);
    try {
      payload = JSON.parse(encodedPayload);
    } catch {
      throw new Error(`[section-invalid] Section "${entry.id}" is not canonical JSON payload.`);
    }
    if (canonicalStringify(payload) !== encodedPayload) {
      throw new Error(`[section-invalid] Section "${entry.id}" payload is not canonical JSON.`);
    }
    sections.push({
      id: entry.id,
      kind: entry.kind,
      required: entry.required,
      ...(entry.target === undefined ? {} : { target: entry.target }),
      payload
    });
  }
  const semanticContentHash = await semanticDigest(envelope.sections, {
    artifactKind: envelope.artifactKind,
    manifestSchemaVersion: envelope.manifestSchemaVersion,
    shaderManifestSchemaVersion: envelope.shaderManifestSchemaVersion,
    shaderModuleSchemaVersion: envelope.shaderModuleSchemaVersion,
    shaderAbiVersion: envelope.shaderAbiVersion,
    ...(envelope.artifactKind === 'material'
      ? { materialSchemaVersion: envelope.materialSchemaVersion }
      : {}),
    toolchain: envelope.toolchain,
    shaderToolchain: envelope.shaderToolchain
  });
  if (
    envelope.semanticContentHash !== semanticContentHash ||
    envelope.packageId !== `render:${semanticContentHash}`
  ) {
    throw new Error('[semantic-integrity-failed] Package semantic identity is invalid.');
  }
  validateInput({
    containerVersion: envelope.containerVersion,
    manifestSchemaVersion: envelope.manifestSchemaVersion,
    shaderManifestSchemaVersion: envelope.shaderManifestSchemaVersion,
    shaderModuleSchemaVersion: envelope.shaderModuleSchemaVersion,
    artifactKind: envelope.artifactKind,
    shaderAbiVersion: envelope.shaderAbiVersion,
    toolchain: envelope.toolchain,
    shaderToolchain: envelope.shaderToolchain,
    sections,
    ...(envelope.artifactKind === 'material'
      ? { materialSchemaVersion: envelope.materialSchemaVersion as number }
      : {})
  } as RenderArtifactPackageInput);
  return Object.freeze({
    envelope: freezeRecord(envelope) as unknown as RenderArtifactEnvelope,
    sections: Object.freeze(sections.map((section) => freezeRecord(section)))
  });
}

function validateInput(input: RenderArtifactPackageInput): void {
  if ((input.containerVersion ?? 1) !== 1) {
    throw new Error('[container-version-unsupported] Only container version 1 is supported.');
  }
  if (input.manifestSchemaVersion !== undefined && input.manifestSchemaVersion !== 1) {
    throw new Error(
      `[manifest-schema-version-unsupported] Only manifestSchemaVersion 1 is supported.`
    );
  }
  if (input.shaderManifestSchemaVersion !== undefined && input.shaderManifestSchemaVersion !== 1) {
    throw new Error(
      `[shader-manifest-schema-version-unsupported] Only shaderManifestSchemaVersion 1 is supported.`
    );
  }
  if (input.shaderModuleSchemaVersion !== undefined && input.shaderModuleSchemaVersion !== 2) {
    throw new Error(
      `[shader-module-schema-version-unsupported] Only shaderModuleSchemaVersion 2 is supported.`
    );
  }
  if (input.shaderToolchain.sourceKind === 'wgsl' && !input.shaderToolchain.nagaVersion?.trim()) {
    throw new Error('[shader-toolchain-invalid] WGSL packages require nagaVersion provenance.');
  }
  const artifactKind = (input as { readonly artifactKind: unknown }).artifactKind;
  if (artifactKind !== 'shader-library' && artifactKind !== 'material') {
    throw new Error(`[artifact-kind-invalid] Unsupported artifact kind "${String(artifactKind)}".`);
  }
  if (
    input.artifactKind === 'material' &&
    (!Number.isInteger(input.materialSchemaVersion) || input.materialSchemaVersion <= 0)
  ) {
    throw new Error(
      '[material-schema-version-invalid] Material packages require a positive schema version.'
    );
  }
  const ids = new Set<string>();
  const kinds = new Set<RenderArtifactSectionKind>();
  for (const section of input.sections) {
    if (!section.id.trim() || ids.has(section.id)) {
      throw new Error(`[section-index-invalid] Duplicate or empty section id "${section.id}".`);
    }
    ids.add(section.id);
    kinds.add(section.kind);
  }
  const requiredSections =
    input.artifactKind === 'material'
      ? [...REQUIRED_SHADER_LIBRARY_SECTIONS, ...REQUIRED_MATERIAL_SECTIONS]
      : REQUIRED_SHADER_LIBRARY_SECTIONS;
  for (const kind of requiredSections) {
    if (!kinds.has(kind)) {
      throw new Error(`[required-section-missing] Production package requires "${kind}".`);
    }
  }
}

async function containerDigest(
  envelope: unknown,
  blobs: ReadonlyMap<string, Uint8Array>
): Promise<string> {
  const parts: Uint8Array[] = [UTF8.encode(canonicalStringify({ envelope }))];
  for (const [blobId, bytes] of [...blobs].sort(([left], [right]) => left.localeCompare(right))) {
    parts.push(UTF8.encode(canonicalStringify({ blobId, length: bytes.byteLength })), bytes);
  }
  return sha256(concatBytes(parts));
}

async function semanticDigest(
  sections: readonly RenderArtifactSectionIndex[],
  semanticHeader: unknown
): Promise<string> {
  return sha256(
    UTF8.encode(
      canonicalStringify({
        header: semanticHeader,
        sections: sections
          .filter(({ kind }) => !NON_SEMANTIC_SECTIONS.has(kind))
          .map(({ id, kind, hash, required, target }) => ({
            id,
            kind,
            hash,
            required,
            ...(target === undefined ? {} : { target })
          }))
      })
    )
  );
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new Uint8Array(bytes).buffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

function freezeRecord<T>(value: T): Readonly<T> {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeRecord)) as unknown as Readonly<T>;
  if (!isRecord(value)) return value;
  return Object.freeze(
    Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, freezeRecord(entry)]))
  ) as Readonly<T>;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function copyBlobs(blobs: ReadonlyMap<string, Uint8Array>): ReadonlyMap<string, Uint8Array> {
  return new OwnedBlobMap(blobs);
}

/** Owns section bytes and never exposes its mutable backing map or byte arrays. */
class OwnedBlobMap implements ReadonlyMap<string, Uint8Array> {
  readonly #blobs: Map<string, Uint8Array>;

  constructor(blobs: ReadonlyMap<string, Uint8Array>) {
    this.#blobs = new Map([...blobs].map(([blobId, bytes]) => [blobId, bytes.slice()]));
  }

  get size(): number {
    return this.#blobs.size;
  }

  get(blobId: string): Uint8Array | undefined {
    return this.#blobs.get(blobId)?.slice();
  }

  has(blobId: string): boolean {
    return this.#blobs.has(blobId);
  }

  *entries(): MapIterator<[string, Uint8Array]> {
    for (const [blobId, bytes] of this.#blobs) yield [blobId, bytes.slice()];
  }

  *keys(): MapIterator<string> {
    yield* this.#blobs.keys();
  }

  *values(): MapIterator<Uint8Array> {
    for (const bytes of this.#blobs.values()) yield bytes.slice();
  }

  forEach(
    callback: (value: Uint8Array, key: string, map: ReadonlyMap<string, Uint8Array>) => void,
    thisArg?: unknown
  ): void {
    for (const [blobId, bytes] of this.#blobs) callback.call(thisArg, bytes.slice(), blobId, this);
  }

  [Symbol.iterator](): MapIterator<[string, Uint8Array]> {
    return this.entries();
  }
}
