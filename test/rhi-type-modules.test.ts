import { expect, test } from 'vitest';
import type { GPUBufferDescriptor, GPUTextureDescriptor } from '../src/rhi/contracts/webgpu';
import type { GPUBindGroupDescriptor, RHIBuffer, RHITexture } from '../src/rhi/contracts/resource';
import type { RHIRenderPassDescriptor, RenderTargetDescriptor } from '../src/rhi/contracts/render-target';
import type { RHICommandBuffer, RHICommandEncoder, RHICommandRecord } from '../src/rhi/contracts/command';
import type { RHIDevice, RHIQueue } from '../src/rhi/contracts/device';
import type { RHIDevice as BarrelDevice, RHICommandRecord as BarrelCommandRecord } from '../src/rhi/contracts';

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
