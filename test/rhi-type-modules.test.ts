import { expect, test } from 'vitest';
import type { GPUBufferDescriptor, GPUTextureDescriptor } from '../src/rhi/webgpu-types';
import type { GPUBindGroupDescriptor, RHIBuffer, RHITexture } from '../src/rhi/resource-types';
import type { RHIRenderPassDescriptor, RenderTargetDescriptor } from '../src/rhi/render-target-types';
import type { RHICommandBuffer, RHICommandEncoder, RHICommandRecord } from '../src/rhi/command-types';
import type { RHIDevice, RHIQueue } from '../src/rhi/device-types';
import type { RHIDevice as BarrelDevice, RHICommandRecord as BarrelCommandRecord } from '../src/rhi/types';

type FocusedModuleImports = {
  bufferDescriptor: GPUBufferDescriptor;
  textureDescriptor: GPUTextureDescriptor;
  buffer: RHIBuffer;
  texture: RHITexture;
  bindGroupDescriptor: GPUBindGroupDescriptor;
  renderTargetDescriptor: RenderTargetDescriptor;
  renderPassDescriptor: RHIRenderPassDescriptor;
  commandBuffer: RHICommandBuffer;
  commandEncoder: RHICommandEncoder;
  commandRecord: RHICommandRecord;
  queue: RHIQueue;
  device: RHIDevice;
  barrelDevice: BarrelDevice;
  barrelCommandRecord: BarrelCommandRecord;
};

test('focused RHI type modules are importable alongside the compatibility barrel', () => {
  const importSmoke: keyof FocusedModuleImports = 'device';

  expect(importSmoke).toBe('device');
});
