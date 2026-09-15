import { computePositionBounds3 } from '../../canonical/bounds';
import type {
  Bounds3,
  CanonicalMeshDocument,
  CanonicalMeshPrimitive,
  CanonicalSamplerDocument,
  CanonicalSceneDocument,
  CanonicalStandardPbrMaterial,
  CanonicalTextureDocument,
  CanonicalTextureSlot,
  CanonicalVertexAttribute,
  CanonicalVertexSemantic
} from '../../canonical/types';
import type {
  AssetDiagnosticSink,
  AssetImportBudget,
  AssetImportStatistics
} from '../../importer/types';
import type { AssetId } from '../../types';
import type { GLTFWithBuffers } from '../loaders-gl';
import { OwnershipTransferTracker } from '../loaders-gl/transfer-ownership';
import { unpackGltfIndices, unpackGltfVertexAttribute } from './gltf-accessors';
import { validateGltfRequiredExtensions } from './gltf-extensions';
import { unpackGltfMaterial, unpackTextureUvTransform } from './gltf-materials';
import { unpackGltfNodes } from './gltf-nodes';
import { decodeDataUri } from './gltf-raw-parser';

export interface GltfImportedBundle {
  readonly scene: CanonicalSceneDocument;
  readonly meshes: readonly CanonicalMeshDocument[];
  readonly materials: readonly CanonicalStandardPbrMaterial[];
  readonly textures: readonly CanonicalTextureDocument[];
  readonly samplers: readonly CanonicalSamplerDocument[];
  readonly statistics: AssetImportStatistics;
}

export interface ResolvedGltfImage {
  readonly data?: Uint8Array;
  readonly uri?: string;
  readonly mimeType?: string;
}

export interface GltfAdapterOptions {
  readonly assetPrefix?: string;
  readonly resolvedImages?: ReadonlyMap<number, ResolvedGltfImage>;
  readonly budget?: AssetImportBudget;
  readonly diagnostics?: AssetDiagnosticSink;
}

const ATTRIBUTE_SEMANTIC_MAP: Readonly<Record<string, CanonicalVertexSemantic>> = Object.freeze({
  POSITION: 'position',
  NORMAL: 'normal',
  TANGENT: 'tangent',
  TEXCOORD_0: 'texcoord-0',
  TEXCOORD_1: 'texcoord-1',
  COLOR_0: 'color-0'
});

/**
 * Transforms raw glTF with buffers into Aether canonical documents.
 */
export function adaptGltfToCanonical(
  gltfWithBuffers: GLTFWithBuffers,
  options: GltfAdapterOptions = {}
): GltfImportedBundle {
  const startTime = performance.now();
  const tracker = new OwnershipTransferTracker(options.budget);
  const prefix = options.assetPrefix ?? 'gltf.asset';
  const gltf = gltfWithBuffers.json;
  const buffers = gltfWithBuffers.buffers;

  // 1. Verify required extensions
  validateGltfRequiredExtensions(gltf);

  // 2. Extract samplers
  const samplers = extractSamplers(gltf, prefix);
  const defaultSamplerId = `${prefix}:sampler:default` as AssetId;

  // 3. Extract textures
  const textures = extractTextures(gltf, prefix, buffers, tracker, options.resolvedImages);

  // 4. Helper for material texture slots
  const getTextureSlot = (
    info: Record<string, any> | undefined,
    _role: 'color' | 'data' | 'normal',
    slotPath?: string
  ): CanonicalTextureSlot | null => {
    if (info === undefined || info === null) return null;
    const path = slotPath ?? 'texture';
    if (typeof info.index !== 'number' || !Number.isSafeInteger(info.index) || info.index < 0) {
      throw new Error(
        `Invalid texture index "${info.index}" at ${path}: index must be a non-negative integer.`
      );
    }
    const gltfTex = gltf.textures?.[info.index];
    if (!gltfTex) {
      throw new Error(
        `Missing texture dependency at ${path}: texture index ${info.index} not found in glTF textures (total: ${gltf.textures?.length ?? 0}).`
      );
    }

    const textureId = `${prefix}:texture:${info.index}` as AssetId;
    const samplerId =
      gltfTex.sampler !== undefined
        ? (`${prefix}:sampler:${gltfTex.sampler}` as AssetId)
        : defaultSamplerId;

    const transform = unpackTextureUvTransform(info);
    const requestedCoord = transform.texCoord ?? info.texCoord ?? 0;
    if (requestedCoord !== 0 && requestedCoord !== 1) {
      throw new Error(
        `Unsupported UV set index: ${requestedCoord}. Canonical assets only support texCoord 0 and 1.`
      );
    }
    const texCoord = requestedCoord as 0 | 1;

    return Object.freeze({
      textureId,
      samplerId,
      texCoord,
      transform
    });
  };

  // 5. Extract materials
  const rawMaterials = Array.isArray(gltf.materials) ? gltf.materials : [];
  const materials = rawMaterials.map((mat: any, idx: number) =>
    unpackGltfMaterial(idx, mat, {
      assetPrefix: prefix,
      defaultSamplerId,
      getTextureSlot
    })
  );

  // 6. Extract meshes
  const rawMeshes = Array.isArray(gltf.meshes) ? gltf.meshes : [];
  const meshes = rawMeshes.map((mesh: any, meshIdx: number) =>
    extractMesh(meshIdx, mesh, gltf, buffers, prefix, materials, tracker, options.diagnostics)
  );

  // 7. Extract nodes
  const rawNodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const nodes = unpackGltfNodes(rawNodes, { assetPrefix: prefix });

  // 8. Extract scene
  const sceneIndex = typeof gltf.scene === 'number' ? gltf.scene : 0;
  const rawScene = gltf.scenes?.[sceneIndex];
  const rootNodes = Array.isArray(rawScene?.nodes) ? (rawScene.nodes as number[]) : [];

  const scene: CanonicalSceneDocument = Object.freeze({
    id: `${prefix}:scene:${sceneIndex}` as AssetId,
    kind: 'scene',
    version: 1,
    ...(rawScene?.name ? { name: rawScene.name } : {}),
    nodes,
    rootNodes: Object.freeze([...rootNodes]),
    defaultSceneIndex: sceneIndex
  });

  const parseTimeMs = performance.now() - startTime;
  const totalReadBytes = buffers.reduce((acc: number, b: Uint8Array) => acc + b.byteLength, 0);

  const statistics: AssetImportStatistics = Object.freeze({
    parseTimeMs,
    readBytes: totalReadBytes,
    copiedBytes: tracker.copiedBytes,
    documentCount: 1 + meshes.length + materials.length + textures.length + samplers.length
  });

  return Object.freeze({
    scene,
    meshes: Object.freeze(meshes),
    materials: Object.freeze(materials),
    textures: Object.freeze(textures),
    samplers: Object.freeze(samplers),
    statistics
  });
}

function extractMesh(
  meshIndex: number,
  rawMesh: Record<string, any>,
  gltf: Record<string, any>,
  buffers: readonly Uint8Array[],
  prefix: string,
  materials: readonly CanonicalStandardPbrMaterial[],
  tracker: OwnershipTransferTracker,
  diagnostics?: AssetDiagnosticSink
): CanonicalMeshDocument {
  const rawPrimitives = Array.isArray(rawMesh.primitives) ? rawMesh.primitives : [];
  const primitives: CanonicalMeshPrimitive[] = [];

  for (let i = 0; i < rawPrimitives.length; i += 1) {
    const rawPrim = rawPrimitives[i]!;
    const mode = rawPrim.mode ?? 4; // 4 = TRIANGLES
    if (mode !== 4) {
      throw new Error(
        `Unsupported glTF primitive mode ${mode} in mesh ${meshIndex}, primitive ${i}: only TRIANGLES (mode 4) is supported.`
      );
    }

    const attributes: CanonicalVertexAttribute[] = [];
    const rawAttrs = rawPrim.attributes ?? {};

    for (const [key, semantic] of Object.entries(ATTRIBUTE_SEMANTIC_MAP)) {
      const accessorIndex = rawAttrs[key];
      if (typeof accessorIndex === 'number') {
        const accessor = gltf.accessors?.[accessorIndex];
        if (!accessor) throw new Error(`Accessor ${accessorIndex} not found for attribute ${key}.`);
        attributes.push(unpackGltfVertexAttribute(semantic, accessor, gltf, buffers, tracker));
      }
    }

    const positionAttr = attributes.find((a) => a.semantic === 'position');
    if (!positionAttr) {
      throw new Error(`Mesh ${meshIndex}, primitive ${i} is missing mandatory POSITION attribute.`);
    }

    let indices = null;
    if (typeof rawPrim.indices === 'number') {
      const accessor = gltf.accessors?.[rawPrim.indices];
      if (!accessor) throw new Error(`Index accessor ${rawPrim.indices} not found.`);
      indices = unpackGltfIndices(accessor, gltf, buffers, tracker);
    }

    const bounds = derivePrimitiveBounds(rawPrim, gltf, positionAttr, diagnostics, meshIndex, i);
    const materialId =
      typeof rawPrim.material === 'number' && materials[rawPrim.material]
        ? materials[rawPrim.material]!.id
        : null;

    primitives.push(
      Object.freeze({
        topology: 'triangle-list',
        attributes: Object.freeze(attributes),
        indices,
        materialId,
        bounds
      })
    );
  }

  return Object.freeze({
    id: `${prefix}:mesh:${meshIndex}` as AssetId,
    kind: 'mesh',
    version: 1,
    ...(rawMesh.name ? { name: rawMesh.name } : {}),
    primitives: Object.freeze(primitives)
  });
}

function derivePrimitiveBounds(
  rawPrim: Record<string, any>,
  gltf: Record<string, any>,
  positionAttr: CanonicalVertexAttribute,
  diagnostics?: AssetDiagnosticSink,
  meshIndex?: number,
  primIndex?: number
): Bounds3 {
  const posData =
    positionAttr.data instanceof Float32Array
      ? positionAttr.data
      : new Float32Array(
          positionAttr.data.buffer,
          positionAttr.data.byteOffset,
          positionAttr.data.byteLength / 4
        );
  const computed = computePositionBounds3(posData, positionAttr.count);

  const posAccessorIdx = rawPrim.attributes?.POSITION;
  const accessor = posAccessorIdx !== undefined ? gltf.accessors?.[posAccessorIdx] : undefined;

  if (
    accessor?.min &&
    accessor?.max &&
    Array.isArray(accessor.min) &&
    Array.isArray(accessor.max) &&
    accessor.min.length >= 3 &&
    accessor.max.length >= 3
  ) {
    const [minX, minY, minZ] = accessor.min;
    const [maxX, maxY, maxZ] = accessor.max;
    const tolerance = 1e-4;
    const encloses =
      minX <= computed.min[0] + tolerance &&
      minY <= computed.min[1] + tolerance &&
      minZ <= computed.min[2] + tolerance &&
      maxX >= computed.max[0] - tolerance &&
      maxY >= computed.max[1] - tolerance &&
      maxZ >= computed.max[2] - tolerance;

    if (!encloses && diagnostics) {
      diagnostics.report({
        code: 'bounds-mismatch',
        message: `Mesh ${meshIndex ?? 0} primitive ${primIndex ?? 0} accessor min/max does not enclose actual vertex positions. Using computed bounds.`,
        severity: 'warning'
      });
    }
  }

  return computed;
}

function extractSamplers(
  gltf: Record<string, any>,
  prefix: string
): readonly CanonicalSamplerDocument[] {
  const rawSamplers = Array.isArray(gltf.samplers) ? gltf.samplers : [];
  const result: CanonicalSamplerDocument[] = [];

  for (let i = 0; i < rawSamplers.length; i += 1) {
    const s = rawSamplers[i]!;
    const minFilter = mapMinFilter(s.minFilter);
    result.push(
      Object.freeze({
        id: `${prefix}:sampler:${i}` as AssetId,
        kind: 'sampler',
        version: 1,
        ...(s.name ? { name: s.name } : {}),
        wrapS: mapWrapMode(s.wrapS),
        wrapT: mapWrapMode(s.wrapT),
        magFilter: s.magFilter === 9728 ? 'nearest' : 'linear',
        ...(minFilter ? { minFilter } : {})
      })
    );
  }

  // glTF 2.0 default sampler: repeat wrap, linear filtering
  result.push(
    Object.freeze({
      id: `${prefix}:sampler:default` as AssetId,
      kind: 'sampler',
      version: 1,
      name: 'glTF Default Sampler',
      wrapS: 'repeat',
      wrapT: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear'
    })
  );

  return Object.freeze(result);
}

function mapWrapMode(mode?: number): 'repeat' | 'clamp-to-edge' | 'mirrored-repeat' {
  if (mode === 33071) return 'clamp-to-edge';
  if (mode === 33648) return 'mirrored-repeat';
  return 'repeat';
}

function mapMinFilter(mode?: number): CanonicalSamplerDocument['minFilter'] {
  if (mode === 9728) return 'nearest';
  if (mode === 9729) return 'linear';
  if (mode === 9984) return 'nearest-mipmap-nearest';
  if (mode === 9985) return 'linear-mipmap-nearest';
  if (mode === 9986) return 'nearest-mipmap-linear';
  if (mode === 9987) return 'linear-mipmap-linear';
  return 'linear';
}

function extractTextures(
  gltf: Record<string, any>,
  prefix: string,
  buffers: readonly Uint8Array[],
  tracker: OwnershipTransferTracker,
  resolvedImages?: ReadonlyMap<number, ResolvedGltfImage>
): readonly CanonicalTextureDocument[] {
  const rawTextures = Array.isArray(gltf.textures) ? gltf.textures : [];
  const result: CanonicalTextureDocument[] = [];

  for (let i = 0; i < rawTextures.length; i += 1) {
    const t = rawTextures[i]!;
    const imageIndex = t.source as number | undefined;
    const rawImage = imageIndex !== undefined ? gltf.images?.[imageIndex] : undefined;
    const resolved = imageIndex !== undefined ? resolvedImages?.get(imageIndex) : undefined;

    let data: Uint8Array | undefined = resolved?.data;
    let uri: string | undefined = resolved?.uri ?? rawImage?.uri;
    let mimeType: string | undefined = resolved?.mimeType ?? rawImage?.mimeType;

    // Decode inline data URI if present directly on rawImage.uri
    if (!data && rawImage?.uri?.startsWith('data:')) {
      const decoded = decodeDataUri(rawImage.uri);
      data = decoded.data;
      if (decoded.mimeType) mimeType = decoded.mimeType;
      tracker.recordCopy(data.byteLength);
    }

    if (!data && rawImage?.bufferView !== undefined) {
      const bv = gltf.bufferViews?.[rawImage.bufferView];
      if (bv) {
        const buffer = buffers[bv.buffer];
        if (buffer) {
          const byteOffset = bv.byteOffset ?? 0;
          const byteLength = bv.byteLength ?? buffer.byteLength - byteOffset;
          data = buffer.slice(byteOffset, byteOffset + byteLength);
          tracker.recordCopy(byteLength);
        }
      }
    }

    result.push(
      Object.freeze({
        id: `${prefix}:texture:${i}` as AssetId,
        kind: 'texture',
        version: 1,
        ...(t.name ? { name: t.name } : {}),
        ...(mimeType ? { mimeType } : {}),
        ...(uri ? { uri } : {}),
        ...(data ? { data } : {})
      })
    );
  }

  return Object.freeze(result);
}
