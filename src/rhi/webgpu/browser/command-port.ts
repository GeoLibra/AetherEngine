import type {
  WebGPUNativeCommandEncoderPort,
  WebGPUNativeComputePassPort,
  WebGPUNativeRenderPassPort,
  WebGPUNativeResourcePort
} from '../types';
import { lowerBrowserDescriptor } from './descriptor-lowering';
import {
  BrowserWebGPUResourcePort,
  unwrapBrowserWebGPUResource,
  type BrowserWebGPUDeviceOwner
} from './resource-port';

export function createBrowserWebGPUCommandEncoderPort(
  nativeDevice: object,
  owner: BrowserWebGPUDeviceOwner,
  descriptor: Readonly<Record<string, unknown>>
): WebGPUNativeCommandEncoderPort {
  const native = requireObject(
    callRequired(nativeDevice, 'createCommandEncoder', [
      lowerBrowserDescriptor(descriptor, ['label'], identity)
    ]),
    'GPUCommandEncoder'
  );

  return {
    pushDebugGroup(label): void {
      callRequired(native, 'pushDebugGroup', [label]);
    },
    popDebugGroup(): void {
      callRequired(native, 'popDebugGroup', []);
    },
    beginRenderPass(passDescriptor): WebGPUNativeRenderPassPort {
      const lowered = lowerBrowserDescriptor(
        passDescriptor,
        [
          'label',
          'colorAttachments',
          'depthStencilAttachment',
          'occlusionQuerySet',
          'timestampWrites'
        ],
        (value) => lowerResource(value, owner)
      );
      return createRenderPassPort(
        requireObject(callRequired(native, 'beginRenderPass', [lowered]), 'GPURenderPassEncoder'),
        owner
      );
    },
    beginComputePass(passDescriptor): WebGPUNativeComputePassPort {
      const lowered = lowerBrowserDescriptor(
        passDescriptor,
        ['label', 'timestampWrites'],
        (value) => lowerResource(value, owner)
      );
      return createComputePassPort(
        requireObject(callRequired(native, 'beginComputePass', [lowered]), 'GPUComputePassEncoder'),
        owner
      );
    },
    copyBufferToBuffer(source, sourceOffset, destination, destinationOffset, size): void {
      callRequired(native, 'copyBufferToBuffer', [
        unwrapBrowserWebGPUResource(source, owner),
        sourceOffset,
        unwrapBrowserWebGPUResource(destination, owner),
        destinationOffset,
        size
      ]);
    },
    copyTextureToTexture(source, destination, size): void {
      callRequired(native, 'copyTextureToTexture', [
        lowerRecord(source, owner),
        lowerRecord(destination, owner),
        size
      ]);
    },
    copyBufferToTexture(source, destination, size): void {
      callRequired(native, 'copyBufferToTexture', [
        lowerRecord(source, owner),
        lowerRecord(destination, owner),
        size
      ]);
    },
    copyTextureToBuffer(source, destination, size): void {
      callRequired(native, 'copyTextureToBuffer', [
        lowerRecord(source, owner),
        lowerRecord(destination, owner),
        size
      ]);
    },
    finish(finishDescriptor): WebGPUNativeResourcePort {
      const commandBuffer = requireObject(
        callRequired(native, 'finish', [
          lowerBrowserDescriptor(finishDescriptor, ['label'], identity)
        ]),
        'GPUCommandBuffer'
      );
      return new BrowserWebGPUResourcePort(owner, commandBuffer);
    }
  };
}

function createRenderPassPort(
  native: object,
  owner: BrowserWebGPUDeviceOwner
): WebGPUNativeRenderPassPort {
  return {
    pushDebugGroup(label): void {
      callRequired(native, 'pushDebugGroup', [label]);
    },
    popDebugGroup(): void {
      callRequired(native, 'popDebugGroup', []);
    },
    setPipeline(pipeline): void {
      callRequired(native, 'setPipeline', [unwrapBrowserWebGPUResource(pipeline, owner)]);
    },
    setBindGroup(index, bindGroup, dynamicOffsets): void {
      callRequired(native, 'setBindGroup', [
        index,
        unwrapBrowserWebGPUResource(bindGroup, owner),
        dynamicOffsets
      ]);
    },
    setVertexBuffer(slot, buffer, offset, size): void {
      callOptionalSize(
        native,
        'setVertexBuffer',
        [slot, unwrapBrowserWebGPUResource(buffer, owner), offset],
        size
      );
    },
    setIndexBuffer(buffer, format, offset, size): void {
      callOptionalSize(
        native,
        'setIndexBuffer',
        [unwrapBrowserWebGPUResource(buffer, owner), format, offset],
        size
      );
    },
    setViewport(x, y, width, height, minDepth, maxDepth): void {
      callRequired(native, 'setViewport', [x, y, width, height, minDepth, maxDepth]);
    },
    setScissorRect(x, y, width, height): void {
      callRequired(native, 'setScissorRect', [x, y, width, height]);
    },
    draw(vertexCount, instanceCount, firstVertex, firstInstance): void {
      callRequired(native, 'draw', [vertexCount, instanceCount, firstVertex, firstInstance]);
    },
    drawIndexed(indexCount, instanceCount, firstIndex, baseVertex, firstInstance): void {
      callRequired(native, 'drawIndexed', [
        indexCount,
        instanceCount,
        firstIndex,
        baseVertex,
        firstInstance
      ]);
    },
    drawIndirect(buffer, offset): void {
      callRequired(native, 'drawIndirect', [unwrapBrowserWebGPUResource(buffer, owner), offset]);
    },
    end(): void {
      callRequired(native, 'end', []);
    }
  };
}

function createComputePassPort(
  native: object,
  owner: BrowserWebGPUDeviceOwner
): WebGPUNativeComputePassPort {
  return {
    pushDebugGroup(label): void {
      callRequired(native, 'pushDebugGroup', [label]);
    },
    popDebugGroup(): void {
      callRequired(native, 'popDebugGroup', []);
    },
    setPipeline(pipeline): void {
      callRequired(native, 'setPipeline', [unwrapBrowserWebGPUResource(pipeline, owner)]);
    },
    setBindGroup(index, bindGroup, dynamicOffsets): void {
      callRequired(native, 'setBindGroup', [
        index,
        unwrapBrowserWebGPUResource(bindGroup, owner),
        dynamicOffsets
      ]);
    },
    dispatchWorkgroups(x, y, z): void {
      callRequired(native, 'dispatchWorkgroups', [x, y, z]);
    },
    dispatchWorkgroupsIndirect(buffer, offset): void {
      callRequired(native, 'dispatchWorkgroupsIndirect', [
        unwrapBrowserWebGPUResource(buffer, owner),
        offset
      ]);
    },
    end(): void {
      callRequired(native, 'end', []);
    }
  };
}

function lowerRecord(
  record: Readonly<Record<string, unknown>>,
  owner: BrowserWebGPUDeviceOwner
): Readonly<Record<string, unknown>> {
  return lowerBrowserDescriptor(record, Object.keys(record), (value) =>
    lowerResource(value, owner)
  );
}

function lowerResource(value: unknown, owner: BrowserWebGPUDeviceOwner): unknown {
  return value instanceof BrowserWebGPUResourcePort
    ? unwrapBrowserWebGPUResource(value, owner)
    : value;
}

function callOptionalSize(
  target: object,
  key: string,
  args: readonly unknown[],
  size: number | undefined
): void {
  callRequired(target, key, size === undefined ? args : [...args, size]);
}

function callRequired(target: object, key: string, args: readonly unknown[]): unknown {
  const method = Reflect.get(target, key);
  if (typeof method !== 'function')
    throw new TypeError(`Native WebGPU object does not implement ${key}().`);
  return Reflect.apply(method, target, args);
}

function requireObject(value: unknown, label: string): object {
  if (typeof value !== 'object' || value === null)
    throw new TypeError(`${label} is not an object.`);
  return value;
}

function identity(value: unknown): unknown {
  return value;
}
