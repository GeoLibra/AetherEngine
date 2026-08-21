export type MeshTopology = 'triangles' | 'lines' | 'points';
/** Canonical vertex formats currently accepted by the mesh validator. */
export type VertexFormat =
  'float32' | 'float32x2' | 'float32x3' | 'float32x4' | 'uint16x2' | 'uint16x4' | 'unorm8x4';

/** One caller-owned vertex byte stream and its per-vertex decoding contract. */
export interface VertexStreamInput {
  /** Shader-facing semantic such as POSITION, NORMAL, or TEXCOORD_0. */
  readonly semantic: string;
  readonly format: VertexFormat;
  readonly stride: number;
  readonly offset: number;
  readonly count: number;
  readonly data: ArrayBufferView;
}

/** Optional indexed-draw data using an explicit unsigned element width. */
export interface MeshIndexInput {
  /** Index width; the typed array must have the corresponding element type. */
  readonly format: 'u16' | 'u32';
  readonly data: Uint16Array | Uint32Array;
}

/** One material-selectable draw range within the canonical mesh. */
export interface SubmeshRange {
  readonly start: number;
  readonly count: number;
  readonly materialSlot: number;
}

/** Untrusted canonical mesh input accepted at import, recipe, or asset boundaries. */
export interface MeshDataInput {
  /** Primitive assembly topology used by every submesh in this payload. */
  readonly topology: MeshTopology;
  readonly vertexCount: number;
  readonly streams: readonly VertexStreamInput[];
  readonly indices?: MeshIndexInput;
  readonly submeshes: readonly SubmeshRange[];
}

/** Deterministic object-local bounds derived from finite POSITION values. */
export interface MeshBounds {
  /** Object-local bounds in engine meters. */
  readonly aabb: Readonly<{
    min: readonly [number, number, number];
    max: readonly [number, number, number];
  }>;
  readonly sphere: Readonly<{ center: readonly [number, number, number]; radius: number }>;
}

/** Validated, caller-isolated canonical CPU mesh payload. */
export interface MeshData extends MeshDataInput {
  /** Bounds derived from the validated POSITION stream. */
  readonly bounds: MeshBounds;
}

/** Explicit policy switches for canonical mesh validation. */
export interface MeshValidationOptions {
  /** Enables explicitly authored overlapping draw ranges; disabled by default. */
  readonly allowSubmeshOverlap?: boolean;
}
