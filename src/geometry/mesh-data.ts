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

const VERTEX_FORMAT_ALIGNMENT: Readonly<Record<VertexFormat, number>> = Object.freeze({
  float32: 4,
  float32x2: 4,
  float32x3: 4,
  float32x4: 4,
  uint16x2: 2,
  uint16x4: 2,
  unorm8x4: 1
});

/** Validates and takes an isolated copy of canonical CPU mesh data. */
export function validateMeshData(
  input: MeshDataInput,
  options: MeshValidationOptions = {}
): MeshData {
  requireCount(input.vertexCount, 'Mesh vertex count');
  if (input.vertexCount === 0) throw new Error('Mesh must contain at least one vertex.');
  if (input.streams.length === 0) throw new Error('Mesh must contain vertex streams.');
  if (input.frontFace !== 'ccw' && input.frontFace !== 'cw') {
    throw new Error('Mesh front face must be either "ccw" or "cw".');
  }

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
    input.topology,
    options.allowSubmeshOverlap === true
  );
  validateTopology(input.topology, drawCount);
  const bounds =
    input.bounds === undefined ? deriveBounds(position) : validateBounds(input.bounds, position);

  return Object.freeze({
    topology: input.topology,
    frontFace: input.frontFace,
    vertexCount: input.vertexCount,
    streams: Object.freeze(streams),
    ...(indices === undefined ? {} : { indices }),
    submeshes,
    bounds
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
  const alignment = VERTEX_FORMAT_ALIGNMENT[stream.format];
  if (stream.offset % alignment !== 0 || stream.stride < size || stream.stride % alignment !== 0) {
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
  topology: MeshDataInput['topology'],
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
    validateTopology(topology, range.count, 'Submesh');
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

function validateTopology(
  topology: MeshDataInput['topology'],
  drawCount: number,
  label = topology === 'triangles'
    ? 'Triangle mesh'
    : topology === 'lines'
      ? 'Line mesh'
      : 'Point mesh'
): void {
  if (topology === 'triangles' && drawCount % 3 !== 0) {
    throw new Error(`${label} draw count must be divisible by three.`);
  }
  if (topology === 'lines' && drawCount % 2 !== 0) {
    throw new Error(`${label} draw count must be divisible by two.`);
  }
}

function validateBounds(bounds: MeshBounds, position: VertexStreamInput): MeshBounds {
  const min = copyVector(bounds.aabb.min, 'Mesh AABB minimum');
  const max = copyVector(bounds.aabb.max, 'Mesh AABB maximum');
  const center = copyVector(bounds.sphere.center, 'Mesh bounding-sphere center');
  if (min.some((value, axis) => value > max[axis]!)) {
    throw new Error('Mesh AABB minimum must not exceed its maximum.');
  }
  if (!Number.isFinite(bounds.sphere.radius) || bounds.sphere.radius < 0) {
    throw new Error('Mesh bounding-sphere radius must be finite and non-negative.');
  }
  const bytes = new DataView(
    position.data.buffer,
    position.data.byteOffset,
    position.data.byteLength
  );
  const radiusSquared = bounds.sphere.radius * bounds.sphere.radius;
  for (let vertex = 0; vertex < position.count; vertex += 1) {
    const base = position.offset + vertex * position.stride;
    const values = [0, 1, 2].map((axis) => bytes.getFloat32(base + axis * 4, true));
    if (values.some((value) => !Number.isFinite(value))) {
      throw new Error('Mesh POSITION values must be finite.');
    }
    if (values.some((value, axis) => value < min[axis]! || value > max[axis]!)) {
      throw new Error('Mesh authored AABB must contain every POSITION value.');
    }
    const distanceSquared = values.reduce((sum, value, axis) => {
      const delta = value - center[axis]!;
      return sum + delta * delta;
    }, 0);
    if (distanceSquared > radiusSquared) {
      throw new Error('Mesh authored bounding sphere must contain every POSITION value.');
    }
  }
  return Object.freeze({
    aabb: Object.freeze({ min: Object.freeze(min), max: Object.freeze(max) }),
    sphere: Object.freeze({ center: Object.freeze(center), radius: bounds.sphere.radius })
  });
}

function copyVector(
  vector: readonly [number, number, number],
  label: string
): [number, number, number] {
  if (vector.length !== 3 || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(`${label} must contain three finite values.`);
  }
  return [vector[0], vector[1], vector[2]];
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
