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
  normalizeExtent,
  releaseWebGL2Native
} from './resource';
import { WebGL2Queue } from './upload';

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
    private readonly native: WebGL2NativeContextPort
  ) {
    this.owner = {
      token: Symbol('WebGL2Device'),
      generation: this.generation,
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
    if (descriptor.mappedAtCreation === true) {
      throw new Error(`WebGL2 buffer "${descriptor.label ?? 'unlabeled'}" does not support mappedAtCreation.`);
    }
    const create = this.native.createBuffer;
    if (create === undefined) return pending('createBuffer');
    const snapshot = Object.freeze({ ...descriptor });
    return new WebGL2Buffer(this.allocateId(), this.owner, create.call(this.native, snapshot), descriptor);
  }
  createTexture(descriptor: RHITextureDescriptor): RHITexture {
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
  createShaderModule(_descriptor: RHIShaderModuleDescriptor): RHIShaderModule { return pending('createShaderModule'); }
  createBindGroupLayout(_descriptor: RHIBindGroupLayoutDescriptor): RHIBindGroupLayout { return pending('createBindGroupLayout'); }
  createPipelineLayout(_descriptor: RHIPipelineLayoutDescriptor): RHIPipelineLayout { return pending('createPipelineLayout'); }
  createBindGroup(_descriptor: RHIBindGroupDescriptor): RHIBindGroup { return pending('createBindGroup'); }
  createRenderPipeline(_descriptor: RHIRenderPipelineDescriptor): RHIRenderPipeline { return pending('createRenderPipeline'); }
  createComputePipeline(_descriptor: RHIComputePipelineDescriptor = {}): RHIComputePipeline { return pending('createComputePipeline'); }
  createCommandEncoder(_descriptor: RHICommandEncoderDescriptor = {}): RHICommandEncoder { return pending('createCommandEncoder'); }

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
