import type { CookedMeshArtifact, CookedSceneArtifact, CookedTextureArtifact } from './types';

const ARTIFACT_MAGIC = 0x41454152; // 'AEAR'
const ARTIFACT_VERSION = 2;

const KIND_TAGS = {
  mesh: 1,
  texture: 2,
  sampler: 3,
  scene: 4
} as const;

/**
 * Serializes a cooked asset artifact into a versioned binary container.
 */
export function encodeCookedArtifact(
  artifact: CookedMeshArtifact | CookedTextureArtifact | CookedSceneArtifact
): Uint8Array {
  const kindTag = KIND_TAGS[artifact.kind as keyof typeof KIND_TAGS];
  if (!kindTag) {
    throw new Error(`Unsupported artifact kind: ${artifact.kind}`);
  }

  // Extract binary buffer payload if texture
  let binaryPayload: Uint8Array = new Uint8Array(0);
  let metadataObj: Record<string, unknown>;

  if (artifact.kind === 'texture') {
    binaryPayload = artifact.data;
    metadataObj = {
      id: artifact.id,
      kind: artifact.kind,
      version: artifact.version,
      role: artifact.role,
      semantic: artifact.semantic,
      format: artifact.format,
      width: artifact.width,
      height: artifact.height,
      mipCount: artifact.mipCount
    };
  } else {
    metadataObj = artifact as unknown as Record<string, unknown>;
  }

  const jsonBytes = new TextEncoder().encode(JSON.stringify(metadataObj));
  const totalLength = 16 + jsonBytes.byteLength + binaryPayload.byteLength;
  const result = new Uint8Array(totalLength);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);

  view.setUint32(0, ARTIFACT_MAGIC, true);
  view.setUint32(4, ARTIFACT_VERSION, true);
  view.setUint32(8, kindTag, true);
  view.setUint32(12, jsonBytes.byteLength, true);

  result.set(jsonBytes, 16);
  if (binaryPayload.byteLength > 0) {
    result.set(binaryPayload, 16 + jsonBytes.byteLength);
  }

  return result;
}

/**
 * Deserializes a cooked asset artifact from a binary container.
 */
export function decodeCookedArtifact(
  data: Uint8Array
): CookedMeshArtifact | CookedTextureArtifact | CookedSceneArtifact {
  if (data.byteLength < 16) {
    throw new Error(
      `Invalid artifact data length: ${data.byteLength} is less than 16-byte header.`
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== ARTIFACT_MAGIC) {
    throw new Error(
      `Invalid artifact magic: expected 0x${ARTIFACT_MAGIC.toString(16)}, got 0x${magic.toString(16)}.`
    );
  }

  const version = view.getUint32(4, true);
  if (version !== ARTIFACT_VERSION) {
    throw new Error(`Unsupported artifact version: ${version}.`);
  }

  const kindTag = view.getUint32(8, true);
  const jsonLength = view.getUint32(12, true);

  if (16 + jsonLength > data.byteLength) {
    throw new Error('Corrupted artifact data: JSON payload extends beyond container length.');
  }

  const jsonSlice = data.subarray(16, 16 + jsonLength);
  const jsonText = new TextDecoder('utf-8').decode(jsonSlice);
  const parsedMeta = JSON.parse(jsonText);

  if (kindTag === KIND_TAGS.texture) {
    const binaryData = data.subarray(16 + jsonLength);
    return {
      ...parsedMeta,
      data: new Uint8Array(binaryData.buffer, binaryData.byteOffset, binaryData.byteLength)
    } as CookedTextureArtifact;
  }

  return parsedMeta;
}
