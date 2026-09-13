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
  const count = accessor.count as number;
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid glTF index accessor count: ${count}.`);
  }
  if (count === 0) {
    return { format: 'u16', count: 0, data: new Uint16Array(0) };
  }

  const componentType = accessor.componentType as number;
  const elementByteSize = GLTF_COMPONENT_BYTES[componentType as keyof typeof GLTF_COMPONENT_BYTES];
  if (
    !elementByteSize ||
    (componentType !== GLTF_COMPONENT_TYPES.UNSIGNED_BYTE &&
      componentType !== GLTF_COMPONENT_TYPES.UNSIGNED_SHORT &&
      componentType !== GLTF_COMPONENT_TYPES.UNSIGNED_INT)
  ) {
    throw new Error(
      `Unsupported glTF index componentType: ${componentType}. Must be unsigned byte, short, or int.`
    );
  }

  const rawBytes = getAccessorBytes(accessor, gltf, buffers, count, elementByteSize, tracker);

  if (componentType === GLTF_COMPONENT_TYPES.UNSIGNED_BYTE) {
    // Convert u8 -> u16
    const u16Data = tracker.allocateTypedArray(Uint16Array, count);
    const byteStride = getAccessorStride(accessor, gltf, 1);
    for (let i = 0; i < count; i += 1) {
      u16Data[i] = rawBytes[i * byteStride]!;
    }
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
    const u16Data = tracker.allocateTypedArray(Uint16Array, count);
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    for (let i = 0; i < count; i += 1) {
      u16Data[i] = view.getUint16(i * byteStride, true);
    }
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
    const u32Data = tracker.allocateTypedArray(Uint32Array, count);
    const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
    for (let i = 0; i < count; i += 1) {
      u32Data[i] = view.getUint32(i * byteStride, true);
    }
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
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Invalid glTF vertex attribute accessor count: ${count}.`);
  }

  const normalized = Boolean(accessor.normalized);
  const componentByteSize =
    GLTF_COMPONENT_BYTES[componentType as keyof typeof GLTF_COMPONENT_BYTES];
  if (!componentByteSize) {
    throw new Error(`Unsupported glTF componentType: ${componentType}.`);
  }

  const format = resolveCanonicalFormat(componentType, numComponents, normalized);

  if (count === 0) {
    return {
      semantic,
      format,
      count: 0,
      normalized,
      data: new Uint8Array(0)
    };
  }

  const elementByteSize = numComponents * componentByteSize;
  const byteStride = getAccessorStride(accessor, gltf, elementByteSize);
  const rawBytes = getAccessorBytes(accessor, gltf, buffers, count, elementByteSize, tracker);

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
    const floatData = tracker.allocateTypedArray(Float32Array, count * numComponents);
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
  const intData = tracker.allocateTypedArray(Uint8Array, count * elementByteSize);
  for (let i = 0; i < count; i += 1) {
    const elemOffset = i * byteStride;
    for (let c = 0; c < elementByteSize; c += 1) {
      intData[i * elementByteSize + c] = rawBytes[elemOffset + c]!;
    }
  }

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
  buffers: readonly Uint8Array[],
  count: number,
  elementByteSize: number,
  tracker: OwnershipTransferTracker
): Uint8Array {
  if (count === 0) {
    return new Uint8Array(0);
  }

  if (accessor.bufferView === undefined) {
    // Bufferless accessor (e.g. purely sparse)
    const totalBytes = count * elementByteSize;
    return tracker.allocateTypedArray(Uint8Array, totalBytes);
  }

  const bufferViewIndex = accessor.bufferView as number;
  const bufferView = gltf.bufferViews?.[bufferViewIndex];
  if (!bufferView) {
    throw new Error(`BufferView ${bufferViewIndex} not found in glTF.`);
  }

  const bufferIndex = bufferView.buffer as number;
  const buffer = buffers[bufferIndex];
  if (!buffer) {
    throw new Error(`Buffer ${bufferIndex} required by bufferView ${bufferViewIndex} not found.`);
  }

  const bvByteOffset = (bufferView.byteOffset as number | undefined) ?? 0;
  const bvByteLength =
    (bufferView.byteLength as number | undefined) ?? buffer.byteLength - bvByteOffset;
  if (bvByteOffset < 0 || bvByteLength < 0 || bvByteOffset + bvByteLength > buffer.byteLength) {
    throw new Error(
      `BufferView ${bufferViewIndex} range [${bvByteOffset}, ${bvByteOffset + bvByteLength}) exceeds buffer ${bufferIndex} length ${buffer.byteLength}.`
    );
  }

  const accByteOffset = (accessor.byteOffset as number | undefined) ?? 0;
  if (accByteOffset < 0) {
    throw new Error(`Accessor byteOffset cannot be negative: ${accByteOffset}.`);
  }

  const byteStride = getAccessorStride(accessor, gltf, elementByteSize);
  const totalSpan = (count - 1) * byteStride + elementByteSize;

  if (accByteOffset + totalSpan > bvByteLength) {
    throw new Error(
      `Accessor span [${accByteOffset}, ${accByteOffset + totalSpan}) exceeds bufferView byteLength ${bvByteLength}.`
    );
  }

  const startOffset = buffer.byteOffset + bvByteOffset + accByteOffset;
  if (startOffset + totalSpan > buffer.byteOffset + buffer.byteLength) {
    throw new Error(
      `Accessor startOffset ${startOffset} + span ${totalSpan} exceeds buffer size ${buffer.byteLength}.`
    );
  }

  return new Uint8Array(buffer.buffer, startOffset, totalSpan);
}

function getAccessorStride(
  accessor: Record<string, any>,
  gltf: Record<string, any>,
  elementByteSize: number
): number {
  if (accessor.bufferView !== undefined) {
    const bufferView = gltf.bufferViews?.[accessor.bufferView];
    if (bufferView?.byteStride !== undefined) {
      const stride = bufferView.byteStride as number;
      if (stride < elementByteSize) {
        throw new Error(
          `BufferView byteStride ${stride} must be >= element byte size ${elementByteSize}.`
        );
      }
      if (stride % 4 !== 0) {
        throw new Error(`BufferView byteStride ${stride} must be a multiple of 4.`);
      }
      if (stride > 252) {
        throw new Error(`BufferView byteStride ${stride} exceeds maximum allowed 252.`);
      }
      return stride;
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
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
    return;
  }

  const idxCompType = sparse.indices.componentType as number;
  const idxCompByteSize = GLTF_COMPONENT_BYTES[idxCompType as keyof typeof GLTF_COMPONENT_BYTES];
  if (!idxCompByteSize) {
    throw new Error(`Unsupported sparse indices componentType: ${idxCompType}.`);
  }

  const valCompType = accessor.componentType as number;
  const valCompByteSize = GLTF_COMPONENT_BYTES[valCompType as keyof typeof GLTF_COMPONENT_BYTES];
  if (!valCompByteSize) {
    throw new Error(`Unsupported sparse values componentType: ${valCompType}.`);
  }

  const indicesBytes = getAccessorBytes(
    sparse.indices,
    gltf,
    buffers,
    count,
    idxCompByteSize,
    tracker
  );
  const valuesBytes = getAccessorBytes(
    sparse.values,
    gltf,
    buffers,
    count,
    valCompByteSize,
    tracker
  );

  const idxView = new DataView(
    indicesBytes.buffer,
    indicesBytes.byteOffset,
    indicesBytes.byteLength
  );
  const valView = new DataView(valuesBytes.buffer, valuesBytes.byteOffset, valuesBytes.byteLength);

  for (let i = 0; i < count; i += 1) {
    const targetIdx =
      idxCompType === GLTF_COMPONENT_TYPES.UNSIGNED_BYTE
        ? idxView.getUint8(i)
        : idxCompType === GLTF_COMPONENT_TYPES.UNSIGNED_SHORT
          ? idxView.getUint16(i * 2, true)
          : idxView.getUint32(i * 4, true);

    if (targetIdx < 0 || targetIdx >= target.length) {
      throw new Error(
        `Sparse index ${targetIdx} is out of bounds for target index buffer of length ${target.length}.`
      );
    }

    const val =
      valCompType === GLTF_COMPONENT_TYPES.UNSIGNED_BYTE
        ? valView.getUint8(i)
        : valCompType === GLTF_COMPONENT_TYPES.UNSIGNED_SHORT
          ? valView.getUint16(i * 2, true)
          : valView.getUint32(i * 4, true);

    target[targetIdx] = val;
  }
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
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) {
    return;
  }

  const idxCompType = sparse.indices.componentType as number;
  const idxCompByteSize = GLTF_COMPONENT_BYTES[idxCompType as keyof typeof GLTF_COMPONENT_BYTES];
  if (!idxCompByteSize) {
    throw new Error(`Unsupported sparse indices componentType: ${idxCompType}.`);
  }

  const valCompType = accessor.componentType as number;
  const valCompByteSize = GLTF_COMPONENT_BYTES[valCompType as keyof typeof GLTF_COMPONENT_BYTES];
  if (!valCompByteSize) {
    throw new Error(`Unsupported sparse values componentType: ${valCompType}.`);
  }

  const indicesBytes = getAccessorBytes(
    sparse.indices,
    gltf,
    buffers,
    count,
    idxCompByteSize,
    tracker
  );
  const valuesBytes = getAccessorBytes(
    sparse.values,
    gltf,
    buffers,
    count,
    components * valCompByteSize,
    tracker
  );

  const idxView = new DataView(
    indicesBytes.buffer,
    indicesBytes.byteOffset,
    indicesBytes.byteLength
  );
  const valView = new DataView(valuesBytes.buffer, valuesBytes.byteOffset, valuesBytes.byteLength);

  for (let i = 0; i < count; i += 1) {
    const targetElemIdx =
      idxCompType === GLTF_COMPONENT_TYPES.UNSIGNED_BYTE
        ? idxView.getUint8(i)
        : idxCompType === GLTF_COMPONENT_TYPES.UNSIGNED_SHORT
          ? idxView.getUint16(i * 2, true)
          : idxView.getUint32(i * 4, true);

    if (targetElemIdx < 0 || (targetElemIdx + 1) * components > target.length) {
      throw new Error(
        `Sparse vertex attribute index ${targetElemIdx} is out of bounds for target array length ${target.length}.`
      );
    }

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
}
