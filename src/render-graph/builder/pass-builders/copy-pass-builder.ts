import { BaseGraphResourceBuilder } from './base-pass-builder';
import type {
  BufferHandle,
  BufferRange,
  CopyBufferWriteUsage,
  CopyPassBuilder,
  CopyTextureWriteUsage,
  TextureHandle,
  TextureRange
} from '../../types';

/**
 * Restricted builder implementation for copy passes. Enforces copy-dst-only declarations.
 */
export class CopyPassBuilderImpl extends BaseGraphResourceBuilder implements CopyPassBuilder {
  writeTexture(
    handle: TextureHandle,
    usage: CopyTextureWriteUsage,
    range?: TextureRange
  ): TextureHandle {
    if (usage !== 'copy-dst') {
      throw new Error(
        `Copy pass cannot declare texture write usage "${usage}". Only "copy-dst" is allowed.`
      );
    }
    return this.declareWriteTexture(handle, usage, range);
  }

  writeBuffer(
    handle: BufferHandle,
    usage: CopyBufferWriteUsage,
    range?: BufferRange
  ): BufferHandle {
    if (usage !== 'copy-dst') {
      throw new Error(
        `Copy pass cannot declare buffer write usage "${usage}". Only "copy-dst" is allowed.`
      );
    }
    return this.declareWriteBuffer(handle, usage, range);
  }
}
