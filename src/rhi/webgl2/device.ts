import type { DeviceCapabilities } from '../contracts/capability';
import type { RHICommandEncoder } from '../contracts/command';
import type {
  RHIBindGroupDescriptor,
  RHIBindGroupLayoutDescriptor,
  RHIBufferDescriptor,
  RHICommandEncoderDescriptor,
  RHIPipelineLayoutDescriptor,
  RHISamplerDescriptor,
  RHIShaderModuleDescriptor,
  RHITextureDescriptor
} from '../contracts/descriptor';
import type { RHIDevice } from '../contracts/device';
import type { RHIExtensionToken } from '../contracts/extension';
import type { DeviceLostInfo, RHIDeviceState } from '../contracts/lifecycle';
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
} from '../contracts/resource';
import type { WebGL2NativeContextLostInfo, WebGL2NativeContextPort } from './native-types';
import type { WebGL2DeviceOwner } from './resource-types';
import {
  WebGL2Buffer,
  WebGL2Sampler,
  WebGL2Texture,
  assertWebGL2Resource,
  getWebGL2Handle,
  normalizeExtent
} from './resource';
import { WebGL2Queue } from './queue';
import { WebGL2ShaderModule } from './shader';
import { WebGL2BindGroup, WebGL2BindGroupLayout, WebGL2PipelineLayout } from './bindings';
import { createWebGL2RenderPipeline } from './pipeline';
import type { WebGL2ShaderTranslationPort } from './shader-types';
import { throwWebGL2Unsupported } from './unsupported';
import { WebGL2CommandEncoder } from './command';
import { createWebGL2ContextControl } from './context-control';
import { createWebGL2LossDiagnostic } from './diagnostics';
import { WebGL2ContextControlExtension, type WebGL2ContextControl } from './extension-types';
import {
  initializeWebGL2ClipDepth,
  selectWebGL2ClipDepthMode,
  type WebGL2ClipDepthMode
} from './clip-depth';

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
  private readonly releaseListeners = new Set<
    (resource: import('./resource').WebGL2ResourceBase) => void
  >();
  private readonly contextControl: WebGL2ContextControl;
  private readonly clipDepthMode: WebGL2ClipDepthMode;

  constructor(
    readonly capabilities: DeviceCapabilities,
    private readonly native: WebGL2NativeContextPort,
    private readonly translator?: WebGL2ShaderTranslationPort
  ) {
    this.clipDepthMode = selectWebGL2ClipDepthMode(native.extensions);
    initializeWebGL2ClipDepth(native, this.clipDepthMode);
    this.owner = {
      token: Symbol('WebGL2Device'),
      generation: this.generation,
      capabilities,
      native,
      state: 'live',
      allocateId: () => this.allocateId(),
      subscribeResourceRelease: (listener) => {
        this.releaseListeners.add(listener);
        return () => {
          this.releaseListeners.delete(listener);
        };
      },
      releaseResource: (resource, handle, owned) => {
        for (const listener of this.releaseListeners) listener(resource);
        this.queue.disposeResource(resource, handle, owned);
      }
    };
    this.queue = new WebGL2Queue(this.owner, native);
    this.contextControl = createWebGL2ContextControl(() => this.queue.invalidateExternalState());
    this.lost = new Promise((resolve) => {
      this.resolveLost = resolve;
    });
    void native.lost.then((info) => this.handleNativeLoss(info));
  }

  get state(): RHIDeviceState {
    return this.currentState;
  }
  getExtension<T>(token: RHIExtensionToken<T>): T | undefined {
    if (token.id !== WebGL2ContextControlExtension.id) return undefined;
    return this.contextControl as T;
  }
  createBuffer(descriptor: RHIBufferDescriptor): RHIBuffer {
    if ((descriptor.usage & (1 << 7)) !== 0) {
      return throwWebGL2Unsupported(this.capabilities, 'storage-buffer', 'create-storage-buffer');
    }
    if (descriptor.mappedAtCreation === true) {
      throw new Error(
        `WebGL2 buffer "${descriptor.label ?? 'unlabeled'}" does not support mappedAtCreation.`
      );
    }
    const create = this.native.createBuffer;
    if (create === undefined) return missingNativeOperation('createBuffer');
    const snapshot = Object.freeze({ ...descriptor });
    return new WebGL2Buffer(
      this.allocateId(),
      this.owner,
      create.call(this.native, snapshot),
      descriptor
    );
  }
  createTexture(descriptor: RHITextureDescriptor): RHITexture {
    if ((descriptor.usage & (1 << 3)) !== 0) {
      return throwWebGL2Unsupported(this.capabilities, 'storage-texture', 'create-storage-texture');
    }
    const create = this.native.createTexture;
    if (create === undefined) return missingNativeOperation('createTexture');
    const snapshot = Object.freeze({ ...descriptor, size: normalizeExtent(descriptor.size) });
    return new WebGL2Texture(
      this.allocateId(),
      this.owner,
      create.call(this.native, snapshot),
      descriptor
    );
  }
  createSurfaceBackingTexture(descriptor: RHITextureDescriptor): RHITexture {
    return this.createTexture(descriptor);
  }
  createSurfaceTextureLease(backing: RHITexture): RHITexture {
    const texture = assertWebGL2Resource(backing, this.owner);
    if (!(texture instanceof WebGL2Texture))
      throw new Error('WebGL2 surface backing must be a WebGL2 texture.');
    return new WebGL2Texture(
      this.allocateId(),
      this.owner,
      getWebGL2Handle(texture, this.owner),
      texture.descriptor,
      false
    );
  }
  presentSurfaceTexture(texture: RHITexture): void {
    assertWebGL2Resource(texture, this.owner);
    const present = this.native.presentSurfaceTexture;
    if (present === undefined)
      throw new Error('Native WebGL2 context cannot present a surface texture.');
    present.call(this.native, getWebGL2Handle(texture, this.owner), texture.width, texture.height);
  }
  createSampler(descriptor: RHISamplerDescriptor = {}): RHISampler {
    const create = this.native.createSampler;
    if (create === undefined) return missingNativeOperation('createSampler');
    const snapshot = Object.freeze({ ...descriptor });
    return new WebGL2Sampler(
      this.allocateId(),
      this.owner,
      create.call(this.native, snapshot),
      descriptor
    );
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
        return throwWebGL2Unsupported(
          this.capabilities,
          'storage-texture',
          'create-storage-texture'
        );
      }
    }
    const uniformCount = descriptor.entries.filter(
      (entry) => entry.buffer?.type === 'uniform'
    ).length;
    const textureCount = descriptor.entries.filter((entry) => entry.texture !== undefined).length;
    const uniformLimit = this.native.limits.maxUniformBufferBindings ?? 0;
    const textureLimit = this.native.limits.maxTextureUnits ?? 0;
    if (uniformCount > uniformLimit) {
      throw new Error(
        `WebGL2 bind group layout requires ${uniformCount} uniform buffers, limit is ${uniformLimit}.`
      );
    }
    if (textureCount > textureLimit) {
      throw new Error(
        `WebGL2 bind group layout requires ${textureCount} textures, limit is ${textureLimit}.`
      );
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
      throw new Error(
        `WebGL2 pipeline layout requires ${uniformCount} uniform buffers, limit is ${uniformLimit}.`
      );
    }
    if (textureCount > textureLimit) {
      throw new Error(
        `WebGL2 pipeline layout requires ${textureCount} textures, limit is ${textureLimit}.`
      );
    }
    return new WebGL2PipelineLayout(this.allocateId(), this.owner, descriptor);
  }
  createBindGroup(descriptor: RHIBindGroupDescriptor): RHIBindGroup {
    return new WebGL2BindGroup(this.allocateId(), this.owner, descriptor);
  }
  createRenderPipeline(descriptor: RHIRenderPipelineDescriptor): RHIRenderPipeline {
    return createWebGL2RenderPipeline(
      this.allocateId(),
      this.owner,
      this.translator,
      this.clipDepthMode,
      descriptor
    );
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
    this.queue.handleDeviceLoss('destroyed');
    this.destroyNativeOnce();
    if (wasLive) {
      this.resolveLost(
        Object.freeze({
          reason: 'destroyed',
          message: 'WebGL2Device was destroyed.',
          generation: this.generation
        })
      );
    }
  }

  private handleNativeLoss(info: WebGL2NativeContextLostInfo): void {
    if (this.currentState !== 'live') return;
    this.currentState = 'lost';
    this.owner.state = 'lost';
    this.queue.handleDeviceLoss('context-lost');
    this.resolveLost(createWebGL2LossDiagnostic(this.generation, info));
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

function missingNativeOperation<T>(operation: string): T {
  throw new Error(`Native WebGL2 context does not support ${operation}.`);
}
