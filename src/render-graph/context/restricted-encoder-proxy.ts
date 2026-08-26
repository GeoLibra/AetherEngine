import type {
  RHIBindGroup,
  RHIComputePassEncoder,
  RHIComputePipeline,
  RHIRenderPassEncoder,
  RHIRenderPipeline,
  RHIBuffer
} from '../../rhi/contracts';
import type { EndableRenderPass } from '../executor/executor-cleanup';
import type {
  RestrictedBindGroup,
  RestrictedBufferSlice,
  RestrictedComputePipeline,
  RestrictedRenderPipeline
} from '../types';

export interface BufferCapability {
  readonly buffer: RHIBuffer;
  readonly usage: string;
  readonly offset: number;
  readonly size: number;
}

export interface EncoderProxyContext {
  readonly bindGroups: WeakMap<RestrictedBindGroup, RHIBindGroup>;
  readonly renderPipelines: WeakMap<RestrictedRenderPipeline, RHIRenderPipeline>;
  readonly computePipelines: WeakMap<RestrictedComputePipeline, RHIComputePipeline>;
  readonly bufferCapabilities: WeakMap<RestrictedBufferSlice, BufferCapability>;
  onEnd(): void;
}

export function createTrackedPassProxy<T extends EndableRenderPass>(
  pass: T,
  context: EncoderProxyContext
): T {
  const end = pass.end.bind(pass);
  let ended = false;
  return new Proxy(pass, {
    get: (target, property) => {
      if (property === 'end') {
        return () => {
          if (ended) throw new Error('Render graph pass encoder has already ended.');
          ended = true;
          end();
          context.onEnd();
        };
      }
      if (property === 'setBindGroup') {
        return (index: number, bindGroup: RestrictedBindGroup, offsets?: readonly number[]) => {
          const rawBindGroup = context.bindGroups.get(bindGroup);
          if (rawBindGroup === undefined) {
            throw new Error(
              'Render graph pass can bind only groups created by its restricted device.'
            );
          }
          return (target as unknown as RHIComputePassEncoder).setBindGroup(
            index,
            rawBindGroup,
            offsets
          );
        };
      }
      if (property === 'setPipeline') {
        return (pipeline: RestrictedRenderPipeline | RestrictedComputePipeline) => {
          const rawPipeline =
            pipeline.kind === 'restricted-render-pipeline'
              ? context.renderPipelines.get(pipeline)
              : context.computePipelines.get(pipeline);
          if (rawPipeline === undefined) {
            throw new Error(
              'Render graph pass can use only pipelines created by its restricted device.'
            );
          }
          return (target as unknown as RHIComputePassEncoder).setPipeline(
            rawPipeline as RHIComputePipeline
          );
        };
      }
      if (property === 'setVertexBuffer') {
        return (slot: number, buffer: RestrictedBufferSlice, offset = 0, size?: number) => {
          const binding = boundBuffer(context.bufferCapabilities, buffer, 'vertex', offset, size);
          return (target as unknown as RHIRenderPassEncoder).setVertexBuffer(
            slot,
            binding.buffer,
            binding.offset,
            binding.size
          );
        };
      }
      if (property === 'setIndexBuffer') {
        return (
          buffer: RestrictedBufferSlice,
          format: 'uint16' | 'uint32',
          offset = 0,
          size?: number
        ) => {
          const binding = boundBuffer(context.bufferCapabilities, buffer, 'index', offset, size);
          return (target as unknown as RHIRenderPassEncoder).setIndexBuffer(
            binding.buffer,
            format,
            binding.offset,
            binding.size
          );
        };
      }
      if (property === 'drawIndirect') {
        return (buffer: RestrictedBufferSlice, offset: number) => {
          const binding = boundBuffer(context.bufferCapabilities, buffer, 'indirect', offset);
          return (target as unknown as RHIRenderPassEncoder).drawIndirect(
            binding.buffer,
            binding.offset
          );
        };
      }
      if (property === 'dispatchWorkgroupsIndirect') {
        return (buffer: RestrictedBufferSlice, offset: number) => {
          const binding = boundBuffer(context.bufferCapabilities, buffer, 'indirect', offset);
          return (target as unknown as RHIComputePassEncoder).dispatchWorkgroupsIndirect(
            binding.buffer,
            binding.offset
          );
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}

function boundBuffer(
  bufferCapabilities: WeakMap<RestrictedBufferSlice, BufferCapability>,
  capability: RestrictedBufferSlice,
  usage: 'vertex' | 'index' | 'indirect',
  relativeOffset: number,
  requestedSize?: number
): { readonly buffer: RHIBuffer; readonly offset: number; readonly size: number } {
  const binding = bufferCapabilities.get(capability);
  if (binding === undefined)
    throw new Error('Buffer slice is not owned by this render graph pass.');
  if (binding.usage !== usage)
    throw new Error(`Render graph buffer slice requires ${usage} usage.`);
  if (
    !Number.isSafeInteger(relativeOffset) ||
    relativeOffset < 0 ||
    relativeOffset > binding.size
  ) {
    throw new Error('Render graph buffer binding offset is outside the declared slice.');
  }
  const size = requestedSize ?? binding.size - relativeOffset;
  if (!Number.isSafeInteger(size) || size < 0 || relativeOffset + size > binding.size) {
    throw new Error('Render graph buffer binding size is outside the declared slice.');
  }
  return { buffer: binding.buffer, offset: binding.offset + relativeOffset, size };
}
