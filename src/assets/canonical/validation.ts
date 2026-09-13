import { createBounds3 } from './bounds';
import type {
  Bounds3,
  CanonicalIndexData,
  CanonicalMeshDocument,
  CanonicalMeshPrimitive,
  CanonicalNodeDocument,
  CanonicalSceneDocument,
  CanonicalStandardPbrMaterial,
  CanonicalTextureSlot,
  CanonicalVertexAttribute,
  CanonicalVertexFormat,
  CanonicalVertexSemantic
} from './types';

const VALID_SEMANTICS = new Set<CanonicalVertexSemantic>([
  'position',
  'normal',
  'tangent',
  'texcoord-0',
  'texcoord-1',
  'color-0'
]);

const VALID_FORMATS = new Set<CanonicalVertexFormat>([
  'float32',
  'float32x2',
  'float32x3',
  'float32x4',
  'uint8x4',
  'uint16x2',
  'uint16x4',
  'unorm8x4',
  'unorm16x2',
  'unorm16x4'
]);

/**
 * Creates an isolated, defensively-copied canonical vertex attribute.
 *
 * @throws When count is 0 or data buffer is insufficient for declared format and count.
 */
export function createCanonicalVertexAttribute(
  input: CanonicalVertexAttribute
): CanonicalVertexAttribute {
  if (!VALID_SEMANTICS.has(input.semantic)) {
    throw new Error(`Unsupported canonical vertex semantic: "${input.semantic}".`);
  }
  if (!VALID_FORMATS.has(input.format)) {
    throw new Error(`Unsupported canonical vertex format: "${input.format}".`);
  }
  if (!Number.isInteger(input.count) || input.count <= 0) {
    throw new Error(`Vertex attribute count must be a positive integer (got ${input.count}).`);
  }

  // Defensive copy of typed array data
  const data = copyTypedArray(input.data);

  return {
    semantic: input.semantic,
    format: input.format,
    count: input.count,
    normalized: input.normalized,
    data,
    ...(input.stride !== undefined ? { stride: input.stride } : {})
  };
}

/**
 * Creates an isolated canonical index buffer with format validation.
 */
export function createCanonicalIndexData(input: CanonicalIndexData): CanonicalIndexData {
  if (input.format !== 'u16' && input.format !== 'u32') {
    throw new Error(`Canonical index format must be "u16" or "u32" (got "${input.format}").`);
  }
  if (!Number.isInteger(input.count) || input.count <= 0) {
    throw new Error(`Index count must be a positive integer (got ${input.count}).`);
  }
  const data = input.format === 'u16' ? new Uint16Array(input.data) : new Uint32Array(input.data);

  return {
    format: input.format,
    count: input.count,
    data
  };
}

/**
 * Validates and creates a canonical mesh primitive with defensive copies.
 */
export function createCanonicalMeshPrimitive(
  input: CanonicalMeshPrimitive
): CanonicalMeshPrimitive {
  if (input.topology !== 'triangle-list') {
    throw new Error(`Unsupported mesh primitive topology: "${input.topology}".`);
  }
  if (input.attributes.length === 0) {
    throw new Error('Mesh primitive must contain at least one vertex attribute.');
  }

  const attributes = input.attributes.map(createCanonicalVertexAttribute);
  const positionAttr = attributes.find((attr) => attr.semantic === 'position');
  if (!positionAttr) {
    throw new Error('Mesh primitive requires a "position" vertex attribute.');
  }

  const vertexCount = positionAttr.count;
  for (const attr of attributes) {
    if (attr.count !== vertexCount) {
      throw new Error(
        `Vertex attribute "${attr.semantic}" count (${attr.count}) must match position count (${vertexCount}).`
      );
    }
  }

  let indices: CanonicalIndexData | null = null;
  if (input.indices !== null) {
    indices = createCanonicalIndexData(input.indices);
    for (let i = 0; i < indices.data.length; i += 1) {
      const indexValue = indices.data[i]!;
      if (indexValue >= vertexCount) {
        throw new Error(
          `Index value ${indexValue} exceeds vertex count ${vertexCount} at index ${i}.`
        );
      }
    }
  }

  const bounds = createBounds3(input.bounds.min, input.bounds.max);

  return Object.freeze({
    topology: 'triangle-list',
    attributes: Object.freeze(attributes),
    indices,
    materialId: input.materialId,
    bounds
  });
}

/**
 * Validates and creates a canonical texture slot with strict UV set bounding.
 */
export function createCanonicalTextureSlot(slot: CanonicalTextureSlot): CanonicalTextureSlot {
  if (!slot.textureId.trim()) {
    throw new Error('Texture slot must reference a valid non-empty textureId.');
  }
  if (!slot.samplerId.trim()) {
    throw new Error('Texture slot must reference a valid non-empty samplerId.');
  }
  if (slot.texCoord !== 0 && slot.texCoord !== 1) {
    throw new Error(`Texture slot texCoord must be 0 or 1 (got ${slot.texCoord}).`);
  }

  const transform = Object.freeze({
    offset: Object.freeze([slot.transform.offset[0], slot.transform.offset[1]]) as readonly [
      number,
      number
    ],
    scale: Object.freeze([slot.transform.scale[0], slot.transform.scale[1]]) as readonly [
      number,
      number
    ],
    rotation: slot.transform.rotation,
    ...(slot.transform.texCoord !== undefined ? { texCoord: slot.transform.texCoord } : {})
  });

  return Object.freeze({
    textureId: slot.textureId,
    samplerId: slot.samplerId,
    texCoord: slot.texCoord,
    transform
  });
}

/**
 * Validates and creates a canonical standard PBR material document.
 */
export function createCanonicalStandardPbrMaterial(
  input: CanonicalStandardPbrMaterial
): CanonicalStandardPbrMaterial {
  if (!input.id.trim()) throw new Error('Material id must be non-empty.');

  const baseColorFactor = Object.freeze([
    validateNormalized(input.baseColorFactor[0], 'baseColorFactor[0]'),
    validateNormalized(input.baseColorFactor[1], 'baseColorFactor[1]'),
    validateNormalized(input.baseColorFactor[2], 'baseColorFactor[2]'),
    validateNormalized(input.baseColorFactor[3], 'baseColorFactor[3]')
  ]) as readonly [number, number, number, number];

  const emissiveFactor = Object.freeze([
    validateNonNegative(input.emissiveFactor[0], 'emissiveFactor[0]'),
    validateNonNegative(input.emissiveFactor[1], 'emissiveFactor[1]'),
    validateNonNegative(input.emissiveFactor[2], 'emissiveFactor[2]')
  ]) as readonly [number, number, number];

  const metallicFactor = validateNormalized(input.metallicFactor, 'metallicFactor');
  const roughnessFactor = validateNormalized(input.roughnessFactor, 'roughnessFactor');

  if (input.alphaMode !== 'opaque' && input.alphaMode !== 'mask' && input.alphaMode !== 'blend') {
    throw new Error(`Unsupported material alphaMode: "${input.alphaMode}".`);
  }

  const alphaCutoff = validateNormalized(input.alphaCutoff, 'alphaCutoff');

  const baseColorTexture = input.baseColorTexture
    ? createCanonicalTextureSlot(input.baseColorTexture)
    : null;
  const metallicRoughnessTexture = input.metallicRoughnessTexture
    ? createCanonicalTextureSlot(input.metallicRoughnessTexture)
    : null;

  const normalTexture = input.normalTexture
    ? Object.freeze({
        ...createCanonicalTextureSlot(input.normalTexture),
        scale: validateNonNegative(input.normalTexture.scale, 'normalTexture.scale')
      })
    : null;

  const occlusionTexture = input.occlusionTexture
    ? Object.freeze({
        ...createCanonicalTextureSlot(input.occlusionTexture),
        strength: validateNormalized(input.occlusionTexture.strength, 'occlusionTexture.strength')
      })
    : null;

  const emissiveTexture = input.emissiveTexture
    ? createCanonicalTextureSlot(input.emissiveTexture)
    : null;

  return Object.freeze({
    id: input.id,
    kind: 'material',
    version: input.version,
    ...(input.name !== undefined ? { name: input.name } : {}),
    baseColorFactor,
    baseColorTexture,
    metallicFactor,
    roughnessFactor,
    metallicRoughnessTexture,
    normalTexture,
    occlusionTexture,
    emissiveFactor,
    emissiveTexture,
    alphaMode: input.alphaMode,
    alphaCutoff,
    doubleSided: input.doubleSided
  });
}

/**
 * Validates and creates a canonical scene document.
 */
export function createCanonicalSceneDocument(
  input: CanonicalSceneDocument
): CanonicalSceneDocument {
  if (!input.id.trim()) throw new Error('Scene id must be non-empty.');
  if (input.nodes.length === 0) throw new Error('Scene document must contain at least one node.');

  const nodeCount = input.nodes.length;
  // Verify children indices and detect cycles
  const visited = new Set<number>();
  for (let i = 0; i < nodeCount; i += 1) {
    const node = input.nodes[i]!;
    for (const childIdx of node.children) {
      if (!Number.isInteger(childIdx) || childIdx < 0 || childIdx >= nodeCount) {
        throw new Error(`Node ${i} references out-of-bounds child index ${childIdx}.`);
      }
      if (childIdx === i) {
        throw new Error(`Node ${i} directly references itself as a child.`);
      }
    }
  }

  // Verify root nodes
  for (const rootIdx of input.rootNodes) {
    if (!Number.isInteger(rootIdx) || rootIdx < 0 || rootIdx >= nodeCount) {
      throw new Error(`Root node index ${rootIdx} is out of bounds.`);
    }
  }

  const nodes = input.nodes.map(copyNodeDocument);

  return Object.freeze({
    id: input.id,
    kind: 'scene',
    version: input.version,
    ...(input.name !== undefined ? { name: input.name } : {}),
    nodes: Object.freeze(nodes),
    rootNodes: Object.freeze([...input.rootNodes]),
    ...(input.defaultSceneIndex !== undefined
      ? { defaultSceneIndex: input.defaultSceneIndex }
      : {}),
    ...(input.metadata !== undefined ? { metadata: Object.freeze({ ...input.metadata }) } : {})
  });
}

function copyNodeDocument(node: CanonicalNodeDocument): CanonicalNodeDocument {
  const transform =
    node.transform.kind === 'trs'
      ? Object.freeze({
          kind: 'trs' as const,
          translation: Object.freeze([
            node.transform.translation[0],
            node.transform.translation[1],
            node.transform.translation[2]
          ]) as readonly [number, number, number],
          rotation: Object.freeze([
            node.transform.rotation[0],
            node.transform.rotation[1],
            node.transform.rotation[2],
            node.transform.rotation[3]
          ]) as readonly [number, number, number, number],
          scale: Object.freeze([
            node.transform.scale[0],
            node.transform.scale[1],
            node.transform.scale[2]
          ]) as readonly [number, number, number]
        })
      : Object.freeze({
          kind: 'matrix' as const,
          matrix: Object.freeze([...node.transform.matrix])
        });

  return Object.freeze({
    ...(node.name !== undefined ? { name: node.name } : {}),
    transform,
    ...(node.meshId !== undefined ? { meshId: node.meshId } : {}),
    children: Object.freeze([...node.children]),
    ...(node.cameraIndex !== undefined ? { cameraIndex: node.cameraIndex } : {}),
    ...(node.skinIndex !== undefined ? { skinIndex: node.skinIndex } : {})
  });
}

function copyTypedArray(
  source: Uint8Array | Float32Array | Uint16Array | Uint32Array
): Uint8Array | Float32Array | Uint16Array | Uint32Array {
  if (source instanceof Float32Array) return new Float32Array(source);
  if (source instanceof Uint16Array) return new Uint16Array(source);
  if (source instanceof Uint32Array) return new Uint32Array(source);
  return new Uint8Array(source);
}

function validateNormalized(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`Field "${field}" must be finite and in [0, 1] range (got ${value}).`);
  }
  return value;
}

function validateNonNegative(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Field "${field}" must be finite and non-negative (got ${value}).`);
  }
  return value;
}
