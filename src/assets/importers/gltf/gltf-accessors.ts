import type {
  CanonicalIndexData,
  CanonicalVertexAttribute,
  CanonicalVertexFormat,
  CanonicalVertexSemantic
} from '../../canonical/types';
import type { OwnershipTransferTracker } from '../loaders-gl/transfer-ownership';

export const GLTF_COMPONENT_TYPES = Object.freeze({
  BYTE: 5120,
  UNSIGNED_BYTE: 5121,
  SHORT: 5122,
  UNSIGNED_SHORT: 5123,
  UNSIGNED_INT: 5125,
  FLOAT: 5126
} as const);

export const GLTF_COMPONENT_BYTES = Object.freeze({
  [GLTF_COMPONENT_TYPES.BYTE]: 1,
  [GLTF_COMPONENT_TYPES.UNSIGNED_BYTE]: 1,
  [GLTF_COMPONENT_TYPES.SHORT]: 2,
  [GLTF_COMPONENT_TYPES.UNSIGNED_SHORT]: 2,
  [GLTF_COMPONENT_TYPES.UNSIGNED_INT]: 4,
  [GLTF_COMPONENT_TYPES.FLOAT]: 4
} as const);

export const GLTF_TYPE_COMPONENTS = Object.freeze({
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16
} as const);

/**
 * Unpacks index data from a glTF accessor.
 * Converts UNSIGNED_BYTE (u8) indices to Uint16Array (u16), as WebGPU requires min u16 index.
 */
export function unpackGltfIndices(
  accessor: Record<string, any>,
  gltf: Record<string, any>,
  buffers: readonly Uint8Array[],
  tracker: OwnershipTransferTracker
): CanonicalIndexData {
  const componentType = accessor.componentType as number;
  const count = accessor.count as number;
  const rawBytes = getAccessorBytes(accessor, gltf, buffers);

  if (componentType === GLTF_COMPONENT_TYPES.UNSIGNED_BYTE) {
    // Convert u8 -> u16
    const u16Data = new Uint16Array(count);
    const byteStride = getAccessorStride(accessor, gltf, 1);
    for (let i = 0; i < count; i += 1) {
      u16Data[i] = rawBytes[i * byteStride]!;
    }
    tracker.recordCopy(count * 2);
    applySparseIndices(accessor, gltf, buffers, u16Data, tracker);
    return { format: 'u16', count, data: u16Data };
  }

  if (componentType === GLTF_COMPONENT_TYPES.UNSIGNED_SHORT) {
    const byteStride = getAccessorStride(accessor, gltf, 2);
    if (byteStride === 2 && !accessor.sparse) {
      const u16Data = tracker.obtainTypedArray(
        Uint16Array,
        rawBytes.buffer,
        rawBytes.byteOffset,
        count
      );
      return { format: 'u16', count, data: u16Data };
    }
    const u16Data = new Uint16Array(count);
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    for (let i = 0; i < count; i += 1) {
      u16Data[i] = view.getUint16(i * byteStride, true);
    }
    tracker.recordCopy(count * 2);
    applySparseIndices(accessor, gltf, buffers, u16Data, tracker);
    return { format: 'u16', count, data: u16Data };
  }

  if (componentType === GLTF_COMPONENT_TYPES.UNSIGNED_INT) {
    const byteStride = getAccessorStride(accessor, gltf, 4);
    if (byteStride === 4 && !accessor.sparse) {
      const u32Data = tracker.obtainTypedArray(
        Uint32Array,
        rawBytes.buffer,
        rawBytes.byteOffset,
        count
      );
      return { format: 'u32', count, data: u32Data };
    }
    const u32Data = new Uint32Array(count);
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    for (let i = 0; i < count; i += 1) {
      u32Data[i] = view.getUint32(i * byteStride, true);
    }
    tracker.recordCopy(count * 4);
    applySparseIndices(accessor, gltf, buffers, u32Data, tracker);
    return { format: 'u32', count, data: u32Data };
  }

  throw new Error(`Unsupported glTF index componentType: ${componentType}.`);
}

/**
 * Unpacks a vertex attribute into canonical format, resolving strides, sparse values, and normalization.
 */
export function unpackGltfVertexAttribute(
  semantic: CanonicalVertexSemantic,
  accessor: Record<string, any>,
  gltf: Record<string, any>,
  buffers: readonly Uint8Array[],
  tracker: OwnershipTransferTracker
): CanonicalVertexAttribute {
  const componentType = accessor.componentType as number;
  const accessorType = accessor.type as keyof typeof GLTF_TYPE_COMPONENTS;
  const numComponents = GLTF_TYPE_COMPONENTS[accessorType];
  if (!numComponents) {
    throw new Error(`Unsupported glTF accessor type: "${accessor.type}".`);
  }

  const count = accessor.count as number;
  const normalized = Boolean(accessor.normalized);
  const componentByteSize =
    GLTF_COMPONENT_BYTES[componentType as keyof typeof GLTF_COMPONENT_BYTES];
  if (!componentByteSize) {
    throw new Error(`Unsupported glTF componentType: ${componentType}.`);
  }

  const elementByteSize = numComponents * componentByteSize;
  const byteStride = getAccessorStride(accessor, gltf, elementByteSize);
  const rawBytes = getAccessorBytes(accessor, gltf, buffers);

  // Determine canonical vertex format
  const format = resolveCanonicalFormat(componentType, numComponents, normalized);

  // Fast path: contiguous float32 data without sparse overrides
  if (
    componentType === GLTF_COMPONENT_TYPES.FLOAT &&
    byteStride === elementByteSize &&
    !accessor.sparse
  ) {
    const floatData = tracker.obtainTypedArray(
      Float32Array,
      rawBytes.buffer,
      rawBytes.byteOffset,
      count * numComponents
    );
    return {
      semantic,
      format,
      count,
      normalized: false,
      data: floatData
    };
  }

  // De-interleave / normalize / unpack
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const isFloat = componentType === GLTF_COMPONENT_TYPES.FLOAT || normalized;

  if (isFloat) {
    const floatData = new Float32Array(count * numComponents);
    for (let i = 0; i < count; i += 1) {
      const elemOffset = i * byteStride;
      for (let c = 0; c < numComponents; c += 1) {
        const compOffset = elemOffset + c * componentByteSize;
        floatData[i * numComponents + c] = readFloatComponent(
          view,
          compOffset,
          componentType,
          normalized
        );
      }
    }
    tracker.recordCopy(floatData.byteLength);
    applySparseFloats(accessor, gltf, buffers, floatData, numComponents, normalized, tracker);
    return {
      semantic,
      format: (numComponents === 1
        ? 'float32'
        : `float32x${numComponents}`) as CanonicalVertexFormat,
      count,
      normalized: false,
      data: floatData
    };
  }

  // Integer typed array path
  const intData = new Uint8Array(count * elementByteSize);
  for (let i = 0; i < count; i += 1) {
    const elemOffset = i * byteStride;
    for (let c = 0; c < elementByteSize; c += 1) {
      intData[i * elementByteSize + c] = rawBytes[elemOffset + c]!;
    }
  }
  tracker.recordCopy(intData.byteLength);

  return {
    semantic,
    format,
    count,
    normalized,
    data: intData
  };
}

function resolveCanonicalFormat(
  componentType: number,
  components: number,
  normalized: boolean
): CanonicalVertexFormat {
  if (normalized) {
    if (components === 4 && componentType === GLTF_COMPONENT_TYPES.UNSIGNED_BYTE) {
      return 'unorm8x4';
    }
    if (components === 2 && componentType === GLTF_COMPONENT_TYPES.UNSIGNED_SHORT) {
      return 'unorm16x2';
    }
    if (components === 4 && componentType === GLTF_COMPONENT_TYPES.UNSIGNED_SHORT) {
      return 'unorm16x4';
    }
  }
  if (componentType === GLTF_COMPONENT_TYPES.FLOAT) {
    return (components === 1 ? 'float32' : `float32x${components}`) as CanonicalVertexFormat;
  }
  if (componentType === GLTF_COMPONENT_TYPES.UNSIGNED_SHORT) {
    return `uint16x${components}` as CanonicalVertexFormat;
  }
  if (componentType === GLTF_COMPONENT_TYPES.UNSIGNED_BYTE) {
    return `uint8x${components}` as CanonicalVertexFormat;
  }
  return `float32x${components}` as CanonicalVertexFormat;
}

function getAccessorBytes(
  accessor: Record<string, any>,
  gltf: Record<string, any>,
  buffers: readonly Uint8Array[]
): Uint8Array {
  if (accessor.bufferView === undefined) {
    // Bufferless accessor (e.g. purely sparse)
    const componentType = accessor.componentType as number;
    const numComponents = GLTF_TYPE_COMPONENTS[accessor.type as keyof typeof GLTF_TYPE_COMPONENTS]!;
    const byteSize = GLTF_COMPONENT_BYTES[componentType as keyof typeof GLTF_COMPONENT_BYTES]!;
    return new Uint8Array(accessor.count * numComponents * byteSize);
  }

  const bufferView = gltf.bufferViews?.[accessor.bufferView];
  if (!bufferView) {
    throw new Error(`BufferView ${accessor.bufferView} not found in glTF.`);
  }

  const bufferIndex = bufferView.buffer as number;
  const buffer = buffers[bufferIndex];
  if (!buffer) {
    throw new Error(
      `Buffer ${bufferIndex} required by bufferView ${accessor.bufferView} not found.`
    );
  }

  const bvByteOffset = (bufferView.byteOffset as number | undefined) ?? 0;
  const accByteOffset = (accessor.byteOffset as number | undefined) ?? 0;
  const startOffset = buffer.byteOffset + bvByteOffset + accByteOffset;
  const byteLength = (bufferView.byteLength as number | undefined) ?? buffer.byteLength;

  if (startOffset > buffer.buffer.byteLength) {
    throw new Error(`Accessor start offset ${startOffset} exceeds buffer size.`);
  }

  return new Uint8Array(buffer.buffer, startOffset, byteLength - accByteOffset);
}

function getAccessorStride(
  accessor: Record<string, any>,
  gltf: Record<string, any>,
  elementByteSize: number
): number {
  if (accessor.bufferView !== undefined) {
    const bufferView = gltf.bufferViews?.[accessor.bufferView];
    if (bufferView?.byteStride !== undefined) {
      return bufferView.byteStride as number;
    }
  }
  return elementByteSize;
}

function readFloatComponent(
  view: DataView,
  offset: number,
  componentType: number,
  normalized: boolean
): number {
  switch (componentType) {
    case GLTF_COMPONENT_TYPES.FLOAT:
      return view.getFloat32(offset, true);
    case GLTF_COMPONENT_TYPES.UNSIGNED_BYTE: {
      const val = view.getUint8(offset);
      return normalized ? val / 255.0 : val;
    }
    case GLTF_COMPONENT_TYPES.BYTE: {
      const val = view.getInt8(offset);
      return normalized ? Math.max(val / 127.0, -1.0) : val;
    }
    case GLTF_COMPONENT_TYPES.UNSIGNED_SHORT: {
      const val = view.getUint16(offset, true);
      return normalized ? val / 65535.0 : val;
    }
    case GLTF_COMPONENT_TYPES.SHORT: {
      const val = view.getInt16(offset, true);
      return normalized ? Math.max(val / 32767.0, -1.0) : val;
    }
    case GLTF_COMPONENT_TYPES.UNSIGNED_INT:
      return view.getUint32(offset, true);
    default:
      throw new Error(`Unsupported componentType for float conversion: ${componentType}`);
  }
}

function applySparseIndices(
  accessor: Record<string, any>,
  gltf: Record<string, any>,
  buffers: readonly Uint8Array[],
  target: Uint16Array | Uint32Array,
  tracker: OwnershipTransferTracker
): void {
  if (!accessor.sparse) return;
  const sparse = accessor.sparse;
  const count = sparse.count as number;

  const indicesBytes = getAccessorBytes(sparse.indices, gltf, buffers);
  const valuesBytes = getAccessorBytes(sparse.values, gltf, buffers);

  const idxView = new DataView(
    indicesBytes.buffer,
    indicesBytes.byteOffset,
    indicesBytes.byteLength
  );
  const valView = new DataView(valuesBytes.buffer, valuesBytes.byteOffset, valuesBytes.byteLength);

  const idxCompType = sparse.indices.componentType as number;
  const valCompType = accessor.componentType as number;

  for (let i = 0; i < count; i += 1) {
    const targetIdx =
      idxCompType === GLTF_COMPONENT_TYPES.UNSIGNED_BYTE
        ? idxView.getUint8(i)
        : idxCompType === GLTF_COMPONENT_TYPES.UNSIGNED_SHORT
          ? idxView.getUint16(i * 2, true)
          : idxView.getUint32(i * 4, true);

    const val =
      valCompType === GLTF_COMPONENT_TYPES.UNSIGNED_BYTE
        ? valView.getUint8(i)
        : valCompType === GLTF_COMPONENT_TYPES.UNSIGNED_SHORT
          ? valView.getUint16(i * 2, true)
          : valView.getUint32(i * 4, true);

    target[targetIdx] = val;
  }
  tracker.recordCopy(count * 2);
}

function applySparseFloats(
  accessor: Record<string, any>,
  gltf: Record<string, any>,
  buffers: readonly Uint8Array[],
  target: Float32Array,
  components: number,
  normalized: boolean,
  tracker: OwnershipTransferTracker
): void {
  if (!accessor.sparse) return;
  const sparse = accessor.sparse;
  const count = sparse.count as number;

  const indicesBytes = getAccessorBytes(sparse.indices, gltf, buffers);
  const valuesBytes = getAccessorBytes(sparse.values, gltf, buffers);

  const idxView = new DataView(
    indicesBytes.buffer,
    indicesBytes.byteOffset,
    indicesBytes.byteLength
  );
  const valView = new DataView(valuesBytes.buffer, valuesBytes.byteOffset, valuesBytes.byteLength);

  const idxCompType = sparse.indices.componentType as number;
  const valCompType = accessor.componentType as number;
  const valCompByteSize = GLTF_COMPONENT_BYTES[valCompType as keyof typeof GLTF_COMPONENT_BYTES]!;

  for (let i = 0; i < count; i += 1) {
    const targetElemIdx =
      idxCompType === GLTF_COMPONENT_TYPES.UNSIGNED_BYTE
        ? idxView.getUint8(i)
        : idxCompType === GLTF_COMPONENT_TYPES.UNSIGNED_SHORT
          ? idxView.getUint16(i * 2, true)
          : idxView.getUint32(i * 4, true);

    for (let c = 0; c < components; c += 1) {
      const compOffset = (i * components + c) * valCompByteSize;
      target[targetElemIdx * components + c] = readFloatComponent(
        valView,
        compOffset,
        valCompType,
        normalized
      );
    }
  }
  tracker.recordCopy(count * components * 4);
}
