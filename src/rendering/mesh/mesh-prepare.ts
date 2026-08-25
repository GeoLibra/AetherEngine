import type {
  MeshData,
  MeshFrontFace,
  MeshTopology,
  SubmeshRange,
  VertexFormat
} from '../../geometry';
import type { RHIDevice } from '../../rhi';
import type { RHIBuffer } from '../../rhi/contracts';
import type { PreparedAsset, PreparedVariantKey } from '../world';
import { MESH_BUFFER_USAGE } from './mesh-constants';
import type {
  PreparedMesh,
  PreparedMeshLayout,
  PreparedMeshStreamLayout,
  PreparedMeshVariantInput
} from './types';

export type {
  PreparedMesh,
  PreparedMeshLayout,
  PreparedMeshStreamLayout,
  PreparedMeshVariantInput
} from './types';

/** Creates and uploads one device-specific mesh variant outside the frame hot path. */
export function prepareMesh(
  device: RHIDevice,
  mesh: MeshData,
  variant: PreparedMeshVariantInput
): PreparedAsset<PreparedMesh> {
  if (device.state !== 'live') throw new Error('Mesh preparation requires a live RHI device.');
  validateVariant(variant);
  const owned: RHIBuffer[] = [];
  try {
    const vertexBuffers = mesh.streams.map((stream, bufferSlot) => {
      const buffer = device.createBuffer({
        label: `mesh:${variant.assetId}:${stream.semantic}`,
        size: stream.data.byteLength,
        usage: MESH_BUFFER_USAGE.Vertex | MESH_BUFFER_USAGE.CopyDestination
      });
      owned.push(buffer);
      device.queue.writeBuffer(buffer, 0, stream.data);
      return buffer;
    });
    let indexBuffer: RHIBuffer | undefined;
    if (mesh.indices !== undefined) {
      indexBuffer = device.createBuffer({
        label: `mesh:${variant.assetId}:indices`,
        size: mesh.indices.data.byteLength,
        usage: MESH_BUFFER_USAGE.Index | MESH_BUFFER_USAGE.CopyDestination
      });
      owned.push(indexBuffer);
      device.queue.writeBuffer(indexBuffer, 0, mesh.indices.data);
    }
    const key: PreparedVariantKey = Object.freeze({
      ...variant,
      deviceGeneration: device.generation
    });
    const value: PreparedMesh = Object.freeze({
      deviceGeneration: device.generation,
      layout: Object.freeze({
        topology: mesh.topology,
        frontFace: mesh.frontFace,
        streams: Object.freeze(
          mesh.streams.map((stream, bufferSlot) =>
            Object.freeze({
              semantic: stream.semantic,
              format: stream.format,
              stride: stream.stride,
              offset: stream.offset,
              bufferSlot
            })
          )
        ),
        ...(mesh.indices === undefined
          ? {}
          : {
              indexFormat: mesh.indices.format === 'u16' ? ('uint16' as const) : ('uint32' as const)
            })
      }),
      vertexBuffers: Object.freeze(vertexBuffers),
      ...(indexBuffer === undefined ? {} : { indexBuffer }),
      submeshes: mesh.submeshes,
      byteLength: owned.reduce((sum, buffer) => sum + buffer.size, 0)
    });
    return Object.freeze({ key, value });
  } catch (error) {
    for (const buffer of owned.reverse()) buffer.dispose();
    throw error;
  }
}

/** Disposes all physical buffers owned by a prepared mesh variant. */
export function disposePreparedMesh(mesh: PreparedMesh): void {
  const errors: unknown[] = [];
  for (const buffer of [
    ...mesh.vertexBuffers,
    ...(mesh.indexBuffer === undefined ? [] : [mesh.indexBuffer])
  ]) {
    try {
      buffer.dispose();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'Prepared mesh cleanup failed.');
}

function validateVariant(variant: PreparedMeshVariantInput): void {
  for (const [name, value] of [
    ['asset ID', variant.assetId],
    ['FeaturePolicy key', variant.featurePolicyKey],
    ['ABI version', variant.abiVersion]
  ] as const) {
    if (!value.trim()) throw new Error(`Prepared mesh ${name} must be non-empty.`);
  }
  if (!Number.isSafeInteger(variant.payloadVersion) || variant.payloadVersion < 0) {
    throw new Error('Prepared mesh payload version must be a non-negative safe integer.');
  }
}
