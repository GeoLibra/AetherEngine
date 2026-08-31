import type { MeshFrontFace, MeshTopology, SubmeshRange, VertexFormat } from '../../../geometry';
import type { RHIBuffer } from '../../../rhi/contracts';

/** Stable identities that distinguish one device-specific prepared mesh variant. */
export interface PreparedMeshVariantInput {
  readonly assetId: string;
  readonly payloadVersion: number;
  readonly featurePolicyKey: string;
  readonly abiVersion: string;
}

/** Vertex buffer slot and shader-facing decoding metadata. */
export interface PreparedMeshStreamLayout {
  readonly semantic: string;
  readonly format: VertexFormat;
  readonly stride: number;
  readonly offset: number;
  readonly bufferSlot: number;
}

/** Pipeline-compatible topology, vertex streams, and optional index format. */
export interface PreparedMeshLayout {
  readonly topology: MeshTopology;
  readonly frontFace: MeshFrontFace;
  readonly streams: readonly PreparedMeshStreamLayout[];
  readonly indexFormat?: 'uint16' | 'uint32';
}

/** GPU buffers and immutable draw metadata owned by PreparedAssetRegistry. */
export interface PreparedMesh {
  readonly deviceGeneration: number;
  readonly layout: PreparedMeshLayout;
  readonly vertexBuffers: readonly RHIBuffer[];
  readonly indexBuffer?: RHIBuffer;
  readonly submeshes: readonly SubmeshRange[];
  readonly byteLength: number;
}
