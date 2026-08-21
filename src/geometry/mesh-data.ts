import type {
  MeshBounds,
  MeshData,
  MeshDataInput,
  MeshValidationOptions,
  SubmeshRange,
  VertexFormat,
  VertexStreamInput
} from './types';

const VERTEX_FORMAT_SIZE: Readonly<Record<VertexFormat, number>> = Object.freeze({
  float32: 4,
  float32x2: 8,
  float32x3: 12,
  float32x4: 16,
  uint16x2: 4,
  uint16x4: 8,
  unorm8x4: 4
});

/** Validates and takes an isolated copy of canonical CPU mesh data. */
export function validateMeshData(
  input: MeshDataInput,
  options: MeshValidationOptions = {}
): MeshData {
  requireCount(input.vertexCount, 'Mesh vertex count');
  if (input.vertexCount === 0) throw new Error('Mesh must contain at least one vertex.');
  if (input.streams.length === 0) throw new Error('Mesh must contain vertex streams.');

  const semantics = new Set<string>();
  const streams = input.streams.map((stream) => {
    validateStream(stream, input.vertexCount);
    if (semantics.has(stream.semantic)) {
      throw new Error(`Mesh vertex semantic "${stream.semantic}" is duplicated.`);
    }
    semantics.add(stream.semantic);
    return Object.freeze({ ...stream, data: copyView(stream.data) });
  });
  const position = streams.find((stream) => stream.semantic === 'POSITION');
  if (position === undefined || position.format !== 'float32x3') {
    throw new Error('Mesh requires a POSITION stream with float32x3 format.');
  }

  const indices =
    input.indices === undefined ? undefined : copyIndices(input.indices, input.vertexCount);
  const drawCount = indices?.data.length ?? input.vertexCount;
  const submeshes = validateSubmeshes(
    input.submeshes,
    drawCount,
    options.allowSubmeshOverlap === true
  );
  validateTopology(input.topology, drawCount);

  return Object.freeze({
    topology: input.topology,
    vertexCount: input.vertexCount,
    streams: Object.freeze(streams),
    ...(indices === undefined ? {} : { indices }),
    submeshes,
    bounds: deriveBounds(position)
  });
}

function validateStream(stream: VertexStreamInput, vertexCount: number): void {
  if (!stream.semantic.trim()) throw new Error('Mesh vertex semantic must be non-empty.');
  requireCount(stream.count, `Mesh ${stream.semantic} count`);
  if (stream.count !== vertexCount)
    throw new Error(`Mesh ${stream.semantic} count must match vertex count.`);
  requireCount(stream.offset, `Mesh ${stream.semantic} offset`);
  requireCount(stream.stride, `Mesh ${stream.semantic} stride`);
  const size = VERTEX_FORMAT_SIZE[stream.format];
  if (stream.stride < size || stream.stride % Math.min(size, 4) !== 0) {
    throw new Error(`Mesh ${stream.semantic} stride is incompatible with ${stream.format}.`);
  }
  const requiredBytes = stream.offset + (stream.count - 1) * stream.stride + size;
  if (requiredBytes > stream.data.byteLength) {
    throw new Error(`Mesh ${stream.semantic} stream does not contain its declared range.`);
  }
}

function copyIndices(indices: NonNullable<MeshDataInput['indices']>, vertexCount: number) {
  if (indices.format === 'u16' && !(indices.data instanceof Uint16Array)) {
    throw new Error('Mesh u16 indices require Uint16Array data.');
  }
  if (indices.format === 'u32' && !(indices.data instanceof Uint32Array)) {
    throw new Error('Mesh u32 indices require Uint32Array data.');
  }
  const data =
    indices.format === 'u16' ? new Uint16Array(indices.data) : new Uint32Array(indices.data);
  for (const index of data) {
    if (index >= vertexCount) throw new Error(`Mesh index ${index} is outside the vertex range.`);
  }
  // Typed-array payloads remain owner-controlled after the trust-boundary copy.
  return { format: indices.format, data };
}

function validateSubmeshes(
  ranges: readonly SubmeshRange[],
  drawCount: number,
  allowOverlap: boolean
): readonly SubmeshRange[] {
  if (ranges.length === 0) throw new Error('Mesh must declare at least one submesh.');
  const result = ranges.map((range) => {
    requireCount(range.start, 'Submesh start');
    requireCount(range.count, 'Submesh count');
    requireCount(range.materialSlot, 'Submesh material slot');
    if (range.count === 0 || range.start + range.count > drawCount) {
      throw new Error('Submesh range is outside the mesh draw range.');
    }
    return Object.freeze({ ...range });
  });
  if (!allowOverlap) {
    const ordered = [...result].sort((a, b) => a.start - b.start || a.count - b.count);
    for (let index = 1; index < ordered.length; index += 1) {
      if (ordered[index]!.start < ordered[index - 1]!.start + ordered[index - 1]!.count) {
        throw new Error('Mesh submesh ranges overlap.');
      }
    }
  }
  return Object.freeze(result);
}

function validateTopology(topology: MeshDataInput['topology'], drawCount: number): void {
  if (topology === 'triangles' && drawCount % 3 !== 0) {
    throw new Error('Triangle mesh draw count must be divisible by three.');
  }
  if (topology === 'lines' && drawCount % 2 !== 0) {
    throw new Error('Line mesh draw count must be divisible by two.');
  }
}

function deriveBounds(stream: VertexStreamInput): MeshBounds {
  const bytes = new DataView(stream.data.buffer, stream.data.byteOffset, stream.data.byteLength);
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let vertex = 0; vertex < stream.count; vertex += 1) {
    const base = stream.offset + vertex * stream.stride;
    for (let axis = 0; axis < 3; axis += 1) {
      const value = bytes.getFloat32(base + axis * 4, true);
      if (!Number.isFinite(value)) throw new Error('Mesh POSITION values must be finite.');
      min[axis] = Math.min(min[axis]!, value);
      max[axis] = Math.max(max[axis]!, value);
    }
  }
  const center: [number, number, number] = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2
  ];
  let radiusSquared = 0;
  for (let vertex = 0; vertex < stream.count; vertex += 1) {
    const base = stream.offset + vertex * stream.stride;
    const dx = bytes.getFloat32(base, true) - center[0];
    const dy = bytes.getFloat32(base + 4, true) - center[1];
    const dz = bytes.getFloat32(base + 8, true) - center[2];
    radiusSquared = Math.max(radiusSquared, dx * dx + dy * dy + dz * dz);
  }
  return Object.freeze({
    aabb: Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) }),
    sphere: Object.freeze({ center: Object.freeze(center), radius: Math.sqrt(radiusSquared) })
  });
}

function copyView(view: ArrayBufferView): ArrayBufferView {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
  const Constructor = view.constructor as { new (buffer: ArrayBuffer): ArrayBufferView };
  return new Constructor(bytes.buffer);
}

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer.`);
  }
}
