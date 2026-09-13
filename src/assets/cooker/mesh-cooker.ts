import { validateMeshData } from '../../geometry';
import type { MeshData, MeshIndexInput, VertexStreamInput } from '../../geometry';
import type {
  Bounds3,
  CanonicalMeshDocument,
  CanonicalMeshPrimitive,
  CanonicalStandardPbrMaterial,
  CanonicalVertexAttribute,
  TextureUvTransform
} from '../canonical/types';
import type { CookedMeshArtifact, CookedMeshPrimitive } from './types';
import {
  computeBoundingSphere,
  computeGeometricNormals,
  computeTangents,
  toFloat32Array,
  transformAuthoredTangents,
  transformUvArray,
  validatePrimitiveUvSets
} from './mesh-geometry-utils';

export interface MeshCookOptions {
  readonly materials?:
    ReadonlyMap<string, CanonicalStandardPbrMaterial> | readonly CanonicalStandardPbrMaterial[];
}

/**
 * Cooks a single CanonicalMeshPrimitive into standard ABI streams and optimized indices.
 *
 * Guarantees:
 * 1. Location 0: POSITION (float32x3)
 * 2. Location 1: NORMAL (float32x3, computed from triangle faces if absent)
 * 3. Location 2: TEXCOORD_0 (float32x2, zero-filled if absent and not required by material)
 * 4. Location 3: TEXCOORD_1 (float32x2, zero-filled if absent and not required by material)
 * 5. Location 4: TANGENT (float32x4, transformed under normal transform or computed from target UV)
 * 6. Index optimization: downsamples u32 to u16 when vertex count <= 65536.
 */
export function cookCanonicalMeshPrimitive(
  primitive: CanonicalMeshPrimitive,
  primitiveIndex = 0,
  options?: MeshCookOptions
): CookedMeshPrimitive {
  const positionAttr = primitive.attributes.find((attr) => attr.semantic === 'position');
  if (!positionAttr || positionAttr.format !== 'float32x3') {
    throw new Error('Mesh primitive requires a valid "position" attribute with float32x3 format.');
  }

  // Resolve material if available
  const material =
    primitive.materialId && options?.materials
      ? options.materials instanceof Map
        ? options.materials.get(primitive.materialId)
        : Array.isArray(options.materials)
          ? options.materials.find((m) => m.id === primitive.materialId)
          : undefined
      : undefined;

  // Fail fast if primitive lacks UV sets requested by active texture slots
  validatePrimitiveUvSets(primitive, material);

  const vertexCount = positionAttr.count;
  const positions = toFloat32Array(positionAttr.data);

  // 1. Resolve or compute Normal
  const normalAttr = primitive.attributes.find((attr) => attr.semantic === 'normal');
  const normals = normalAttr
    ? toFloat32Array(normalAttr.data)
    : computeGeometricNormals(positions, vertexCount, primitive.indices?.data);

  // 2. Resolve or zero-fill TEXCOORD_0
  const uv0Attr = primitive.attributes.find((attr) => attr.semantic === 'texcoord-0');
  const uv0 = uv0Attr ? toFloat32Array(uv0Attr.data) : new Float32Array(vertexCount * 2);

  // 3. Resolve or zero-fill TEXCOORD_1
  const uv1Attr = primitive.attributes.find((attr) => attr.semantic === 'texcoord-1');
  const uv1 = uv1Attr ? toFloat32Array(uv1Attr.data) : new Float32Array(vertexCount * 2);

  // 4. Resolve or generate Tangent
  const tangentAttr = primitive.attributes.find((attr) => attr.semantic === 'tangent');
  let tangents: Float32Array;
  let hasGeneratedTangents = false;

  const normalTexCoord = material?.normalTexture?.texCoord ?? 0;
  const normalTransform = material?.normalTexture?.transform;

  if (tangentAttr && tangentAttr.format === 'float32x4' && normalTexCoord === 0) {
    const rawTangents = toFloat32Array(tangentAttr.data);
    tangents = normalTransform
      ? transformAuthoredTangents(rawTangents, normals, vertexCount, normalTransform)
      : rawTangents;
  } else {
    // Generate tangents for the UV set and texture transform matching normalTexture
    const baseUv = normalTexCoord === 1 ? uv1 : uv0;
    const tangentUv = normalTransform
      ? transformUvArray(baseUv, vertexCount, normalTransform)
      : baseUv;
    tangents = computeTangents(positions, normals, tangentUv, vertexCount, primitive.indices?.data);
    hasGeneratedTangents = true;
  }

  // 5. Build streams
  const streams: VertexStreamInput[] = [
    {
      semantic: 'POSITION',
      format: 'float32x3',
      stride: 12,
      offset: 0,
      count: vertexCount,
      data: positions
    },
    {
      semantic: 'NORMAL',
      format: 'float32x3',
      stride: 12,
      offset: 0,
      count: vertexCount,
      data: normals
    },
    {
      semantic: 'TEXCOORD_0',
      format: 'float32x2',
      stride: 8,
      offset: 0,
      count: vertexCount,
      data: uv0
    },
    {
      semantic: 'TEXCOORD_1',
      format: 'float32x2',
      stride: 8,
      offset: 0,
      count: vertexCount,
      data: uv1
    },
    {
      semantic: 'TANGENT',
      format: 'float32x4',
      stride: 16,
      offset: 0,
      count: vertexCount,
      data: tangents
    }
  ];

  // Optional COLOR_0 with VEC3 expansion
  const colorAttr = primitive.attributes.find((attr) => attr.semantic === 'color-0');
  if (colorAttr) {
    if (colorAttr.format === 'float32x4' || colorAttr.format === 'unorm8x4') {
      streams.push({
        semantic: 'COLOR_0',
        format: colorAttr.format,
        stride: colorAttr.stride ?? (colorAttr.format === 'float32x4' ? 16 : 4),
        offset: 0,
        count: vertexCount,
        data: colorAttr.data
      });
    } else if (colorAttr.format === 'float32x3') {
      const src = toFloat32Array(colorAttr.data);
      const expanded = new Float32Array(vertexCount * 4);
      for (let i = 0; i < vertexCount; i += 1) {
        expanded[i * 4] = src[i * 3]!;
        expanded[i * 4 + 1] = src[i * 3 + 1]!;
        expanded[i * 4 + 2] = src[i * 3 + 2]!;
        expanded[i * 4 + 3] = 1.0;
      }
      streams.push({
        semantic: 'COLOR_0',
        format: 'float32x4',
        stride: 16,
        offset: 0,
        count: vertexCount,
        data: expanded
      });
    } else if (colorAttr.format === 'unorm8x3') {
      const src =
        colorAttr.data instanceof Uint8Array
          ? colorAttr.data
          : new Uint8Array(
              colorAttr.data.buffer,
              colorAttr.data.byteOffset,
              colorAttr.data.byteLength
            );
      const expanded = new Uint8Array(vertexCount * 4);
      for (let i = 0; i < vertexCount; i += 1) {
        expanded[i * 4] = src[i * 3]!;
        expanded[i * 4 + 1] = src[i * 3 + 1]!;
        expanded[i * 4 + 2] = src[i * 3 + 2]!;
        expanded[i * 4 + 3] = 255;
      }
      streams.push({
        semantic: 'COLOR_0',
        format: 'unorm8x4',
        stride: 4,
        offset: 0,
        count: vertexCount,
        data: expanded
      });
    } else {
      throw new Error(
        `Unsupported glTF COLOR_0 format: "${colorAttr.format}". Expected float32x3/4 or unorm8x3/4.`
      );
    }
  }

  // 6. Optimize indices
  let cookedIndices: MeshIndexInput | undefined;
  let originalIndexFormat: 'u16' | 'u32' | 'none' = 'none';
  let cookedIndexFormat: 'u16' | 'u32' | 'none' = 'none';

  if (primitive.indices) {
    originalIndexFormat = primitive.indices.format;
    const rawIndices = primitive.indices.data;
    if (primitive.indices.format === 'u32' && vertexCount <= 65536) {
      let canDownsample = true;
      for (let i = 0; i < rawIndices.length; i += 1) {
        if (rawIndices[i]! >= 65536) {
          canDownsample = false;
          break;
        }
      }
      if (canDownsample) {
        const u16Data = new Uint16Array(rawIndices.length);
        u16Data.set(rawIndices);
        cookedIndices = { format: 'u16', data: u16Data };
        cookedIndexFormat = 'u16';
      } else {
        cookedIndices = { format: 'u32', data: rawIndices };
        cookedIndexFormat = 'u32';
      }
    } else {
      cookedIndices = {
        format: primitive.indices.format,
        data: rawIndices
      };
      cookedIndexFormat = primitive.indices.format;
    }
  }

  const drawCount = cookedIndices ? cookedIndices.data.length : vertexCount;
  const meshData: MeshData = validateMeshData({
    topology: 'triangles',
    frontFace: 'ccw',
    vertexCount,
    streams,
    ...(cookedIndices ? { indices: cookedIndices } : {}),
    submeshes: [
      {
        start: 0,
        count: drawCount,
        materialSlot: 0
      }
    ],
    bounds: {
      aabb: primitive.bounds,
      sphere: computeBoundingSphere(positions, vertexCount, primitive.bounds)
    }
  });

  return {
    primitiveIndex,
    materialId: primitive.materialId,
    meshData,
    hasGeneratedTangents,
    originalIndexFormat,
    cookedIndexFormat
  };
}

/**
 * Cooks an entire CanonicalMeshDocument into a CookedMeshArtifact.
 */
export function cookCanonicalMeshDocument(
  mesh: CanonicalMeshDocument,
  options?: MeshCookOptions
): CookedMeshArtifact {
  const cookedPrimitives = mesh.primitives.map((primitive, idx) =>
    cookCanonicalMeshPrimitive(primitive, idx, options)
  );

  let totalByteLength = 0;
  for (const prim of cookedPrimitives) {
    for (const stream of prim.meshData.streams) {
      totalByteLength += stream.data.byteLength;
    }
    if (prim.meshData.indices) {
      totalByteLength += prim.meshData.indices.data.byteLength;
    }
  }

  return {
    id: mesh.id,
    kind: 'mesh',
    version: mesh.version,
    primitives: cookedPrimitives,
    totalByteLength
  };
}
