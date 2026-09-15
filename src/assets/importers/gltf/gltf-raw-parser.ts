import type { GLTFWithBuffers } from '../loaders-gl';

const GLB_MAGIC = 0x46546c67; // 'glTF' in little-endian
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

/**
 * Parses a binary GLB container into its constituent JSON chunk and binary bufferView.
 *
 * @throws When magic, length, or chunk framing is invalid or corrupted.
 */
export function parseGlbContainer(data: Uint8Array): GLTFWithBuffers {
  if (data.byteLength < 12) {
    throw new Error(`Invalid GLB data: length ${data.byteLength} is less than 12-byte header.`);
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const magic = view.getUint32(0, true);
  if (magic !== GLB_MAGIC) {
    throw new Error(
      `Invalid GLB magic signature: expected 0x${GLB_MAGIC.toString(16)}, got 0x${magic.toString(16)}.`
    );
  }

  const version = view.getUint32(4, true);
  if (version !== 2) {
    throw new Error(`Unsupported glTF version ${version}: only glTF 2.0 is supported.`);
  }

  const totalLength = view.getUint32(8, true);
  if (totalLength > data.byteLength) {
    throw new Error(
      `Corrupted GLB: declared length ${totalLength} exceeds available data ${data.byteLength}.`
    );
  }

  let offset = 12;
  let jsonString: string | undefined;
  let binaryChunk: Uint8Array | undefined;

  const utf8Decoder = new TextDecoder('utf-8');

  while (offset < totalLength) {
    if (offset + 8 > totalLength) {
      throw new Error(`Corrupted GLB chunk header at offset ${offset}.`);
    }

    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    offset += 8;

    if (offset + chunkLength > totalLength) {
      throw new Error(
        `Corrupted GLB: chunk length ${chunkLength} at offset ${offset} exceeds total length ${totalLength}.`
      );
    }

    if (chunkType === CHUNK_TYPE_JSON) {
      if (jsonString !== undefined) {
        throw new Error('Multiple JSON chunks encountered in GLB container.');
      }
      const jsonBytes = new Uint8Array(data.buffer, data.byteOffset + offset, chunkLength);
      jsonString = utf8Decoder.decode(jsonBytes);
    } else if (chunkType === CHUNK_TYPE_BIN) {
      if (binaryChunk !== undefined) {
        throw new Error('Multiple BIN chunks encountered in GLB container.');
      }
      binaryChunk = new Uint8Array(data.buffer, data.byteOffset + offset, chunkLength);
    }

    // 4-byte chunk alignment padding
    offset += (chunkLength + 3) & ~3;
  }

  if (jsonString === undefined) {
    throw new Error('GLB container is missing mandatory JSON chunk.');
  }

  let json: Record<string, any>;
  try {
    json = JSON.parse(jsonString);
  } catch (error) {
    throw new Error(`Failed to parse glTF JSON: ${(error as Error).message}`);
  }

  const buffers: Uint8Array[] = [];
  if (binaryChunk) {
    buffers.push(binaryChunk);
  }

  return {
    json,
    buffers,
    ...(binaryChunk !== undefined ? { binary: binaryChunk } : {})
  };
}

/**
 * Parses a glTF JSON text string into a GLTFWithBuffers container.
 */
export function parseGltfJson(
  jsonString: string,
  externalBuffers: readonly Uint8Array[] = []
): GLTFWithBuffers {
  let json: Record<string, any>;
  try {
    json = JSON.parse(jsonString);
  } catch (error) {
    throw new Error(`Failed to parse glTF JSON: ${(error as Error).message}`);
  }

  return {
    json,
    buffers: externalBuffers
  };
}

/**
 * Decodes a data URI into binary bytes and an optional MIME type.
 * Enforces memory allocation budget prior to allocating byte buffers.
 */
export function decodeDataUri(
  dataUri: string,
  budget?: { checkAllocated(bytes: number): void }
): {
  readonly data: Uint8Array;
  readonly mimeType?: string;
} {
  const commaIdx = dataUri.indexOf(',');
  if (commaIdx === -1) throw new Error('Malformed data URI.');
  const meta = dataUri.substring(5, commaIdx);
  const mimeType = meta.split(';')[0] || undefined;
  const base64 = dataUri.substring(commaIdx + 1);
  const binaryString = atob(base64);
  const len = binaryString.length;
  budget?.checkAllocated(len);
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return {
    data: bytes,
    ...(mimeType ? { mimeType } : {})
  };
}
