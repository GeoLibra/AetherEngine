import { BaseGraphResourceBuilder } from './base-pass-builder';
import type {
  BufferHandle,
  BufferRange,
  ComputeBufferWriteUsage,
  ComputePassBuilder,
  ComputePassDeclarationDetails,
  ComputeTextureWriteUsage,
  PreparedComputePipelineToken,
  TextureHandle,
  TextureRange
} from '../../types';

/**
 * Restricted builder implementation for compute passes. Enforces storage-write-only
 * declarations and manages prepared compute pipeline tokens.
 */
export class ComputePassBuilderImpl extends BaseGraphResourceBuilder implements ComputePassBuilder {
  private readonly computePipelines = new Set<PreparedComputePipelineToken>();

  writeTexture(
    handle: TextureHandle,
    usage: ComputeTextureWriteUsage,
    range?: TextureRange
  ): TextureHandle {
    if (usage !== 'storage-write') {
      throw new Error(
        `Compute pass cannot declare texture write usage "${usage}". Only "storage-write" is allowed.`
      );
    }
    return this.declareWriteTexture(handle, usage, range);
  }

  writeBuffer(
    handle: BufferHandle,
    usage: ComputeBufferWriteUsage,
    range?: BufferRange
  ): BufferHandle {
    if (usage !== 'storage-write') {
      throw new Error(
        `Compute pass cannot declare buffer write usage "${usage}". Only "storage-write" is allowed.`
      );
    }
    return this.declareWriteBuffer(handle, usage, range);
  }

  useComputePipeline(token: PreparedComputePipelineToken): void {
    this.assertActive();
    this.computePipelines.add(token);
  }

  declarationDetails(): ComputePassDeclarationDetails {
    return Object.freeze({
      preparedComputePipelines: Object.freeze([...this.computePipelines])
    });
  }
}
