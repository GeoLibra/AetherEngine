import { describe, expect, it } from 'vitest';
import {
  unpackGltfIndices,
  unpackGltfVertexAttribute,
  GLTF_COMPONENT_TYPES
} from '../../src/assets/importers/gltf/gltf-accessors';
import { OwnershipTransferTracker } from '../../src/assets/importers/loaders-gl/transfer-ownership';

describe('glTF Accessor Unpacking', () => {
  it('unpacks contiguous float32 attributes with memory isolation', () => {
    const tracker = new OwnershipTransferTracker();
    const floatData = new Float32Array([0, 1, 2, 3, 4, 5]);
    const buffers = [new Uint8Array(floatData.buffer)];
    const gltf = {
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 24 }],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 0,
          componentType: GLTF_COMPONENT_TYPES.FLOAT,
          count: 2,
          type: 'VEC3'
        }
      ]
    };

    const attr = unpackGltfVertexAttribute('position', gltf.accessors[0]!, gltf, buffers, tracker);
    expect(attr.semantic).toBe('position');
    expect(attr.count).toBe(2);
    expect(attr.format).toBe('float32x3');
    expect(attr.data[0]).toBe(0);
    expect(attr.data[5]).toBe(5);
    expect(tracker.copiedBytes).toBe(24);

    // Mutating source buffer must not affect unpacked attribute data
    buffers[0]![0] = 99;
    expect(attr.data[0]).toBe(0);
  });

  it('unpacks interleaved bufferViews correctly', () => {
    const tracker = new OwnershipTransferTracker();
    // Interleaved buffer: [pos.x, pos.y, pos.z, uv.u, uv.v] -> 3 float32 + 2 float32 = 20 bytes stride
    const interleaved = new Float32Array([1.0, 2.0, 3.0, 0.1, 0.2, 4.0, 5.0, 6.0, 0.3, 0.4]);
    const buffers = [new Uint8Array(interleaved.buffer)];
    const gltf = {
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 40, byteStride: 20 }],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 0,
          componentType: GLTF_COMPONENT_TYPES.FLOAT,
          count: 2,
          type: 'VEC3'
        },
        {
          bufferView: 0,
          byteOffset: 12,
          componentType: GLTF_COMPONENT_TYPES.FLOAT,
          count: 2,
          type: 'VEC2'
        }
      ]
    };

    const pos = unpackGltfVertexAttribute('position', gltf.accessors[0]!, gltf, buffers, tracker);
    expect(pos.count).toBe(2);
    expect(pos.data[0]).toBe(1.0);
    expect(pos.data[1]).toBe(2.0);
    expect(pos.data[2]).toBe(3.0);
    expect(pos.data[3]).toBe(4.0);
    expect(pos.data[4]).toBe(5.0);
    expect(pos.data[5]).toBe(6.0);

    const uv = unpackGltfVertexAttribute('texcoord-0', gltf.accessors[1]!, gltf, buffers, tracker);
    expect(uv.count).toBe(2);
    expect(uv.data[0]).toBeCloseTo(0.1);
    expect(uv.data[1]).toBeCloseTo(0.2);
    expect(uv.data[2]).toBeCloseTo(0.3);
    expect(uv.data[3]).toBeCloseTo(0.4);
  });

  it('unpacks and normalizes unsigned byte attributes', () => {
    const tracker = new OwnershipTransferTracker();
    // 4 unsigned bytes: [255, 128, 0, 64]
    const u8Buffer = new Uint8Array([255, 128, 0, 64]);
    const buffers = [u8Buffer];
    const gltf = {
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 4 }],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 0,
          componentType: GLTF_COMPONENT_TYPES.UNSIGNED_BYTE,
          count: 1,
          type: 'VEC4',
          normalized: true
        }
      ]
    };

    const attr = unpackGltfVertexAttribute('color-0', gltf.accessors[0]!, gltf, buffers, tracker);
    expect(attr.count).toBe(1);
    expect(attr.data[0]).toBeCloseTo(1.0);
    expect(attr.data[1]).toBeCloseTo(128 / 255);
    expect(attr.data[2]).toBeCloseTo(0.0);
    expect(attr.data[3]).toBeCloseTo(64 / 255);
  });

  it('unpacks sparse accessors overriding base values', () => {
    const tracker = new OwnershipTransferTracker();
    // Base: 4 vertices of VEC3 initialized to 0
    const baseBuffer = new Float32Array(12);
    // Sparse indices: index 1 and index 3
    const sparseIndices = new Uint16Array([1, 3]);
    // Sparse values: values for vertex 1 and vertex 3
    const sparseValues = new Float32Array([10, 20, 30, 40, 50, 60]);

    const combinedBuffer = new Uint8Array(
      baseBuffer.byteLength + sparseIndices.byteLength + sparseValues.byteLength
    );
    combinedBuffer.set(new Uint8Array(baseBuffer.buffer), 0);
    combinedBuffer.set(new Uint8Array(sparseIndices.buffer), baseBuffer.byteLength);
    combinedBuffer.set(
      new Uint8Array(sparseValues.buffer),
      baseBuffer.byteLength + sparseIndices.byteLength
    );

    const buffers = [combinedBuffer];
    const gltf = {
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: baseBuffer.byteLength },
        { buffer: 0, byteOffset: baseBuffer.byteLength, byteLength: sparseIndices.byteLength },
        {
          buffer: 0,
          byteOffset: baseBuffer.byteLength + sparseIndices.byteLength,
          byteLength: sparseValues.byteLength
        }
      ],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 0,
          componentType: GLTF_COMPONENT_TYPES.FLOAT,
          count: 4,
          type: 'VEC3',
          sparse: {
            count: 2,
            indices: {
              bufferView: 1,
              byteOffset: 0,
              componentType: GLTF_COMPONENT_TYPES.UNSIGNED_SHORT
            },
            values: {
              bufferView: 2,
              byteOffset: 0
            }
          }
        }
      ]
    };

    const attr = unpackGltfVertexAttribute('position', gltf.accessors[0]!, gltf, buffers, tracker);
    expect(attr.count).toBe(4);
    // Vertex 0: base [0, 0, 0]
    expect(attr.data[0]).toBe(0);
    expect(attr.data[1]).toBe(0);
    expect(attr.data[2]).toBe(0);
    // Vertex 1: sparse [10, 20, 30]
    expect(attr.data[3]).toBe(10);
    expect(attr.data[4]).toBe(20);
    expect(attr.data[5]).toBe(30);
    // Vertex 2: base [0, 0, 0]
    expect(attr.data[6]).toBe(0);
    // Vertex 3: sparse [40, 50, 60]
    expect(attr.data[9]).toBe(40);
    expect(attr.data[10]).toBe(50);
    expect(attr.data[11]).toBe(60);
  });

  it('unpacks unsigned byte indices and converts to u16', () => {
    const tracker = new OwnershipTransferTracker();
    const u8Indices = new Uint8Array([0, 1, 2, 2, 1, 3]);
    const buffers = [u8Indices];
    const gltf = {
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 6 }],
      accessors: [
        {
          bufferView: 0,
          byteOffset: 0,
          componentType: GLTF_COMPONENT_TYPES.UNSIGNED_BYTE,
          count: 6,
          type: 'SCALAR'
        }
      ]
    };

    const indices = unpackGltfIndices(gltf.accessors[0]!, gltf, buffers, tracker);
    expect(indices.format).toBe('u16');
    expect(indices.count).toBe(6);
    expect(indices.data instanceof Uint16Array).toBe(true);
    expect(Array.from(indices.data)).toEqual([0, 1, 2, 2, 1, 3]);
  });
});
