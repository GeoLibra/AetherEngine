import type { DeviceCapabilities } from '../capability-types';
import type { RHICommandEncoder } from '../command-types';
import type {
  RHIBindGroupDescriptor,
  RHIBindGroupLayoutDescriptor,
  RHIBufferDescriptor,
  RHICommandEncoderDescriptor,
  RHIPipelineLayoutDescriptor,
  RHISamplerDescriptor,
  RHIShaderModuleDescriptor,
  RHITextureDescriptor
} from '../descriptor-types';
import type { RHIDevice } from '../device-types';
import type { RHIExtensionToken } from '../extension-types';
import type { DeviceLostInfo, RHIDeviceState } from '../lifecycle-types';
import type {
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIBuffer,
  RHIComputePipeline,
  RHIComputePipelineDescriptor,
  RHIPipelineLayout,
  RHIRenderPipeline,
  RHIRenderPipelineDescriptor,
  RHISampler,
  RHIShaderModule,
  RHITexture
} from '../resource-types';
import type { WebGL2NativeContextLostInfo, WebGL2NativeContextPort } from './native-types';
import type { WebGL2DeviceOwner } from './resource-types';
import {
  WebGL2Buffer,
  WebGL2Sampler,
  WebGL2Texture,
  assertWebGL2Resource,
  normalizeExtent,
  releaseWebGL2Native
} from './resource';
import { WebGL2Queue } from './upload';
import { WebGL2ShaderModule } from './shader';
import { WebGL2BindGroup, WebGL2BindGroupLayout, WebGL2PipelineLayout } from './bindings';
import { createWebGL2RenderPipeline } from './pipeline';
import type { WebGL2ShaderTranslationPort } from './shader-types';
import { throwWebGL2Unsupported } from './unsupported';
import { WebGL2CommandEncoder } from './command';

let nextWebGL2Generation = 1;

export class WebGL2Device implements RHIDevice {
  readonly generation = nextWebGL2Generation++;
  readonly queue: WebGL2Queue;
  readonly lost: Promise<DeviceLostInfo>;
  private readonly owner: WebGL2DeviceOwner;
  private currentState: RHIDeviceState = 'live';
  private resolveLost!: (info: DeviceLostInfo) => void;
  private nativeDestroyed = false;
  private nextResourceId = 1;

  constructor(
    readonly capabilities: DeviceCapabilities,
    private readonly native: WebGL2NativeContextPort,
    private readonly translator?: WebGL2ShaderTranslationPort
  ) {
    this.owner = {
      token: Symbol('WebGL2Device'),
      generation: this.generation,
      capabilities,
      native,
      state: 'live',
      allocateId: () => this.allocateId(),
      releaseResource: (resource, handle, owned) => releaseWebGL2Native(native, resource, handle, owned)
    };
    this.queue = new WebGL2Queue(this.owner, native);
    this.lost = new Promise((resolve) => { this.resolveLost = resolve; });
    void native.lost.then((info) => this.handleNativeLoss(info));
  }

  get state(): RHIDeviceState { return this.currentState; }
  getExtension<T>(_token: RHIExtensionToken<T>): T | undefined { return undefined; }
  createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer {
    if ((descriptor.usage & (1 << 7)) !== 0) {
      return throwWebGL2Unsupported(this.capabilities, 'storage-buffer', 'create-storage-buffer');
    }
    if (descriptor.mappedAtCreation === true) {
      throw new Error(`WebGL2 buffer "${descriptor.label ?? 'unlabeled'}" does not support mappedAtCreation.`);
    }
    const create = this.native.createBuffer;
    if (create === undefined) return pending('createBuffer');
    const snapshot = Object.freeze({ ...descriptor });
    return new WebGL2Buffer(this.allocateId(), this.owner, create.call(this.native, snapshot), descriptor);
  }
  createTexture(descriptor: RHITextureDescriptor): RHITexture {
    if ((descriptor.usage & (1 << 3)) !== 0) {
      return throwWebGL2Unsupported(this.capabilities, 'storage-texture', 'create-storage-texture');
    }
    const create = this.native.createTexture;
    if (create === undefined) return pending('createTexture');
    const snapshot = Object.freeze({ ...descriptor, size: normalizeExtent(descriptor.size) });
    return new WebGL2Texture(this.allocateId(), this.owner, create.call(this.native, snapshot), descriptor);
  }
  createSampler(descriptor: RHISamplerDescriptor = {}): RHISampler {
    const create = this.native.createSampler;
    if (create === undefined) return pending('createSampler');
    const snapshot = Object.freeze({ ...descriptor });
    return new WebGL2Sampler(this.allocateId(), this.owner, create.call(this.native, snapshot), descriptor);
  }
  createShaderModule(descriptor: RHIShaderModuleDescriptor): RHIShaderModule {
    return new WebGL2ShaderModule(this.allocateId(), this.owner, descriptor);
  }
  createBindGroupLayout(descriptor: RHIBindGroupLayoutDescriptor): RHIBindGroupLayout {
    for (const entry of descriptor.entries) {
      if (entry.buffer?.type === 'storage' || entry.buffer?.type === 'read-only-storage') {
        return throwWebGL2Unsupported(this.capabilities, 'storage-buffer', 'create-storage-buffer');
      }
      if (entry.storageTexture !== undefined) {
        return throwWebGL2Unsupported(this.capabilities, 'storage-texture', 'create-storage-texture');
      }
    }
    const uniformCount = descriptor.entries.filter((entry) => entry.buffer?.type === 'uniform').length;
    const textureCount = descriptor.entries.filter((entry) => entry.texture !== undefined).length;
    const uniformLimit = this.native.limits.maxUniformBufferBindings ?? 0;
    const textureLimit = this.native.limits.maxTextureUnits ?? 0;
    if (uniformCount > uniformLimit) {
      throw new Error(`WebGL2 bind group layout requires ${uniformCount} uniform buffers, limit is ${uniformLimit}.`);
    }
    if (textureCount > textureLimit) {
      throw new Error(`WebGL2 bind group layout requires ${textureCount} textures, limit is ${textureLimit}.`);
    }
    return new WebGL2BindGroupLayout(this.allocateId(), this.owner, descriptor);
  }
  createPipelineLayout(descriptor: RHIPipelineLayoutDescriptor): RHIPipelineLayout {
    for (const layout of descriptor.bindGroupLayouts) assertWebGL2Resource(layout, this.owner);
    const entries = descriptor.bindGroupLayouts.flatMap((layout) => [...layout.descriptor.entries]);
    const uniformCount = entries.filter((entry) => entry.buffer?.type === 'uniform').length;
    const textureCount = entries.filter((entry) => entry.texture !== undefined).length;
    const uniformLimit = this.native.limits.maxUniformBufferBindings ?? 0;
    const textureLimit = this.native.limits.maxTextureUnits ?? 0;
    if (uniformCount > uniformLimit) {
      throw new Error(`WebGL2 pipeline layout requires ${uniformCount} uniform buffers, limit is ${uniformLimit}.`);
    }
    if (textureCount > textureLimit) {
      throw new Error(`WebGL2 pipeline layout requires ${textureCount} textures, limit is ${textureLimit}.`);
    }
    return new WebGL2PipelineLayout(this.allocateId(), this.owner, descriptor);
  }
  createBindGroup(descriptor: RHIBindGroupDescriptor): RHIBindGroup {
    return new WebGL2BindGroup(this.allocateId(), this.owner, descriptor);
  }
  createRenderPipeline(descriptor: RHIRenderPipelineDescriptor): RHIRenderPipeline {
    return createWebGL2RenderPipeline(this.allocateId(), this.owner, this.translator, descriptor);
  }
  createComputePipeline(_descriptor: RHIComputePipelineDescriptor = {}): RHIComputePipeline {
    return throwWebGL2Unsupported(this.capabilities, 'compute', 'create-compute-pipeline');
  }
  createCommandEncoder(descriptor: RHICommandEncoderDescriptor = {}): RHICommandEncoder {
    return new WebGL2CommandEncoder(this.allocateId(), this.owner, descriptor);
  }

  destroy(): void {
    if (this.currentState === 'destroyed') return;
    const wasLive = this.currentState === 'live';
    this.currentState = 'destroyed';
    this.owner.state = 'destroyed';
    this.destroyNativeOnce();
    if (wasLive) {
      this.resolveLost(Object.freeze({
        reason: 'destroyed', message: 'WebGL2Device was destroyed.', generation: this.generation
      }));
    }
  }

  private handleNativeLoss(info: WebGL2NativeContextLostInfo): void {
    if (this.currentState !== 'live') return;
    this.currentState = 'lost';
    this.owner.state = 'lost';
    this.resolveLost(Object.freeze({
      reason: info.reason === 'out-of-memory' ? 'out-of-memory' : 'context-lost',
      message: info.message ?? 'WebGL2 context was lost.',
      generation: this.generation
    }));
  }

  private destroyNativeOnce(): void {
    if (this.nativeDestroyed) return;
    this.nativeDestroyed = true;
    this.native.destroy?.();
  }

  private allocateId(): number {
    if (this.currentState !== 'live') throw new Error('WebGL2Device is lost.');
    return this.nextResourceId++;
  }
}

function pending<T>(operation: string): T {
  throw new Error(`WebGL2 backend operation ${operation} is not implemented yet.`);
}
