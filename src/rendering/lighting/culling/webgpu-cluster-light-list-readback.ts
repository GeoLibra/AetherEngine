import type { RHIBuffer } from '../../../rhi/contracts';
import {
  decodeWebGpuClusterLightListOutput,
  type DecodedWebGpuClusterLightListOutput
} from './cluster-light-list';

const MAP_READ = 1 << 0;

/** Physical buffers copied from a completed cluster graph submission. */
export interface WebGpuClusterLightListReadbackBuffers {
  readonly directional: RHIBuffer;
  readonly headers: RHIBuffer;
  readonly indices: RHIBuffer;
  readonly overflow: RHIBuffer;
}

/**
 * Submission-safe readback ticket. All buffers must come from the same device generation; a
 * recreated device invalidates old output rather than allowing stale light assignments to be
 * decoded as current-frame data.
 */
export interface WebGpuClusterLightListReadbackTicket {
  readonly generation: number;
  read(): Promise<DecodedWebGpuClusterLightListOutput>;
}

export function createWebGpuClusterLightListReadbackTicket(
  buffers: WebGpuClusterLightListReadbackBuffers
): WebGpuClusterLightListReadbackTicket {
  const generation = buffers.overflow.generation;
  for (const buffer of Object.values(buffers)) {
    if (buffer.generation !== generation) {
      throw new Error('Cluster light-list readback buffers must share one device generation.');
    }
    if (buffer.size % 4 !== 0) {
      throw new Error('Cluster light-list readback buffers must have a four-byte aligned size.');
    }
  }
  return Object.freeze({
    generation,
    async read() {
      for (const buffer of Object.values(buffers)) {
        if (buffer.generation !== generation) {
          throw new Error('Cluster light-list readback was invalidated by device recreation.');
        }
      }
      const [directionalIndices, headers, lightIndices, overflow] = await Promise.all([
        readWords(buffers.directional),
        readWords(buffers.headers),
        readWords(buffers.indices),
        readWords(buffers.overflow)
      ]);
      return decodeWebGpuClusterLightListOutput({
        directionalIndices,
        headers,
        lightIndices,
        overflow
      });
    }
  });
}

async function readWords(buffer: RHIBuffer): Promise<Uint32Array> {
  if (buffer.size === 0) return new Uint32Array();
  await buffer.mapAsync(MAP_READ);
  try {
    const mapped = buffer.getMappedRange();
    return new Uint32Array(mapped.slice(0));
  } finally {
    buffer.unmap();
  }
}
