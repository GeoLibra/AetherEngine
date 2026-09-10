import type {
  PreparedBindGroupLayoutToken,
  PreparedComputePipelineToken,
  PreparedDrawResourcesToken,
  PreparedRenderPipelineToken
} from '../builder/prepared-resources';
import type { RestrictedContext } from './restricted-context';
import type {
  BufferHandle,
  BufferRange,
  BufferUsage,
  CopyCommands,
  CopyPassContext,
  RestrictedBindGroupLayout,
  RestrictedBufferSlice,
  RestrictedPortableDevice,
  RestrictedTextureView,
  TextureHandle,
  TextureRange,
  TextureUsage
} from '../types';

export class CopyPassContextImpl implements CopyPassContext {
  readonly copy: CopyCommands;

  constructor(private readonly restrictedContext: RestrictedContext) {
    this.copy = Object.freeze({
      copyBufferToBuffer: (
        source: RestrictedBufferSlice,
        destination: RestrictedBufferSlice,
        size?: number
      ): void => restrictedContext.copyBufferToBuffer(source, destination, size)
    });
  }

  get device(): RestrictedPortableDevice {
    return this.restrictedContext.device;
  }

  texture(handle: TextureHandle, usage: TextureUsage, range?: TextureRange): RestrictedTextureView {
    return this.restrictedContext.texture(handle, usage, range);
  }

  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RestrictedBufferSlice {
    return this.restrictedContext.buffer(handle, usage, range);
  }

  renderPipeline(token: PreparedRenderPipelineToken): never {
    throw new Error('Render pipelines cannot be resolved inside a copy pass context.');
  }

  computePipeline(token: PreparedComputePipelineToken): never {
    throw new Error('Compute pipelines cannot be resolved inside a copy pass context.');
  }

  bindGroupLayout(token: PreparedBindGroupLayoutToken): RestrictedBindGroupLayout {
    return this.restrictedContext.bindGroupLayout(token);
  }

  drawResources(token: PreparedDrawResourcesToken): never {
    throw new Error('Draw resources cannot be resolved inside a copy pass context.');
  }
}
