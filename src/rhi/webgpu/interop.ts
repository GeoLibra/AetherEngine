import type { RHICommandEncoder } from '../contracts/command';
import type { RHIExtensionToken } from '../contracts/extension';
import type { RHIResource } from '../contracts/resource';
import { getWebGPUNativeCommandEncoder } from './command';
import type {
  NativeImportDescriptorMap,
  RHINativeResourceMap,
  WebGPUInterop,
  WebGPUInteropSubmissionPolicy,
  WebGPUInteropScope,
  WebGPUNativeImportKind,
  WebGPUNativeKind,
  WebGPUNativeResourceMap
} from './types';
import type {
  WebGPUNativeBufferPort,
  WebGPUNativeDevicePort,
  WebGPUNativeImportTexturePort
} from './types';
import {
  WebGPUBuffer,
  WebGPUResourceBase,
  WebGPUTexture,
  assertWebGPUResource,
  getWebGPUNativeHandle,
  normalizeExtent,
  onWebGPUNativeHandleReleased,
  type WebGPUDeviceOwner
} from './resource';

export const WebGPUInteropExtension: RHIExtensionToken<WebGPUInterop> = Object.freeze({
  id: Symbol('aether.rhi.webgpu.interop'),
  name: 'aether.rhi.webgpu.interop'
});

export class WebGPUInteropController implements WebGPUInterop {
  private readonly nativeOwners = new WeakMap<object, WebGPUInteropScopeImpl>();
  private readonly resourceOwners = new WeakMap<WebGPUResourceBase, WebGPUInteropScopeImpl>();

  constructor(
    readonly deviceGeneration: number,
    private readonly owner: WebGPUDeviceOwner,
    private readonly nativeDevice: WebGPUNativeDevicePort
  ) {}

  createScope(
    owner: string,
    submissionPolicy: WebGPUInteropSubmissionPolicy = 'aether-owned-submission'
  ): WebGPUInteropScope {
    if (this.owner.state !== 'live') throw new Error('WebGPU interop device is lost.');
    if (owner.trim() === '') throw new Error('Interop scope owner must not be empty.');
    if (submissionPolicy === 'independent-submission') {
      throw new Error(
        'Independent native queue submission requires an isolated WebGPU device and surface.'
      );
    }
    return new WebGPUInteropScopeImpl(
      owner,
      this.owner,
      this.nativeDevice,
      this.nativeOwners,
      this.resourceOwners
    );
  }
}

class WebGPUInteropScopeImpl implements WebGPUInteropScope {
  private disposed = false;
  private readonly imports = new Map<WebGPUResourceBase, object>();

  constructor(
    readonly owner: string,
    private readonly deviceOwner: WebGPUDeviceOwner,
    readonly device: WebGPUNativeDevicePort,
    private readonly nativeOwners: WeakMap<object, WebGPUInteropScopeImpl>,
    private readonly resourceOwners: WeakMap<WebGPUResourceBase, WebGPUInteropScopeImpl>
  ) {}

  importBorrowed<K extends WebGPUNativeImportKind>(
    kind: K,
    resource: WebGPUNativeResourceMap[K],
    descriptor: NativeImportDescriptorMap[K]
  ): RHINativeResourceMap[K] {
    return this.importResource(kind, resource, descriptor, false);
  }

  adopt<K extends WebGPUNativeImportKind>(
    kind: K,
    resource: WebGPUNativeResourceMap[K],
    descriptor: NativeImportDescriptorMap[K]
  ): RHINativeResourceMap[K] {
    return this.importResource(kind, resource, descriptor, true);
  }

  unwrapResource<K extends WebGPUNativeKind>(
    kind: K,
    resource: RHINativeResourceMap[K]
  ): WebGPUNativeResourceMap[K] {
    this.assertActive();
    const wrapper = assertWebGPUResource(resource, this.deviceOwner);
    if (toNativeKind(resource.kind) !== kind) {
      throw new Error(`Resource kind "${resource.kind}" cannot be unwrapped as "${kind}".`);
    }
    const importOwner = this.resourceOwners.get(wrapper);
    if (importOwner !== undefined && importOwner !== this) {
      throw new Error(`Resource belongs to interop scope "${importOwner.owner}".`);
    }
    return getWebGPUNativeHandle(resource, this.deviceOwner) as WebGPUNativeResourceMap[K];
  }

  unwrapEncoder(encoder: RHICommandEncoder) {
    this.assertActive();
    return getWebGPUNativeCommandEncoder(encoder, this.deviceOwner);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const resource of this.imports.keys()) resource.dispose();
    this.imports.clear();
  }

  private importResource<K extends WebGPUNativeImportKind>(
    kind: K,
    native: WebGPUNativeResourceMap[K],
    descriptor: NativeImportDescriptorMap[K],
    adopted: boolean
  ): RHINativeResourceMap[K] {
    this.assertActive();
    const claimed = this.nativeOwners.get(native);
    if (claimed !== undefined) {
      throw new Error(`Native resource is already owned by interop scope "${claimed.owner}".`);
    }
    const resource =
      kind === 'buffer'
        ? this.importBuffer(
            native as WebGPUNativeBufferPort,
            descriptor as NativeImportDescriptorMap['buffer'],
            adopted
          )
        : this.importTexture(
            native as WebGPUNativeImportTexturePort,
            descriptor as NativeImportDescriptorMap['texture'],
            adopted
          );
    this.nativeOwners.set(native, this);
    this.resourceOwners.set(resource, this);
    this.imports.set(resource, native);
    onWebGPUNativeHandleReleased(resource, () => {
      this.nativeOwners.delete(native);
      this.resourceOwners.delete(resource);
      this.imports.delete(resource);
    });
    return resource as unknown as RHINativeResourceMap[K];
  }

  private importBuffer(
    native: WebGPUNativeBufferPort,
    descriptor: NativeImportDescriptorMap['buffer'],
    adopted: boolean
  ): WebGPUBuffer {
    if (descriptor.mappedAtCreation === true) {
      throw new Error('Imported buffer descriptor cannot set mappedAtCreation.');
    }
    if (native.size !== descriptor.size) {
      throw new Error(
        `Native buffer size ${native.size} does not match descriptor size ${descriptor.size}.`
      );
    }
    if (native.usage !== descriptor.usage) {
      throw new Error(
        `Native buffer usage ${native.usage} does not match descriptor usage ${descriptor.usage}.`
      );
    }
    return new WebGPUBuffer(
      this.deviceOwner.allocateId(),
      this.deviceOwner,
      native,
      descriptor,
      adopted
    );
  }

  private importTexture(
    native: WebGPUNativeImportTexturePort,
    descriptor: NativeImportDescriptorMap['texture'],
    adopted: boolean
  ): WebGPUTexture {
    const size = normalizeExtent(descriptor.size);
    if (
      native.width !== size.width ||
      native.height !== size.height ||
      native.depthOrArrayLayers !== size.depthOrArrayLayers
    ) {
      throw new Error(
        `Native texture extent ${native.width}x${native.height}x${native.depthOrArrayLayers} does not match ` +
          `descriptor extent ${size.width}x${size.height}x${size.depthOrArrayLayers}.`
      );
    }
    if (native.format !== descriptor.format) {
      throw new Error(
        `Native texture format ${native.format} does not match descriptor format ${descriptor.format}.`
      );
    }
    if (native.usage !== descriptor.usage) {
      throw new Error(
        `Native texture usage ${native.usage} does not match descriptor usage ${descriptor.usage}.`
      );
    }
    const dimension = descriptor.dimension ?? '2d';
    if (native.dimension !== dimension) {
      throw new Error(
        `Native texture dimension ${native.dimension} does not match descriptor dimension ${dimension}.`
      );
    }
    const mipLevelCount = descriptor.mipLevelCount ?? 1;
    if (native.mipLevelCount !== mipLevelCount) {
      throw new Error(
        `Native texture mip level count ${native.mipLevelCount} does not match descriptor mip level count ${mipLevelCount}.`
      );
    }
    const sampleCount = descriptor.sampleCount ?? 1;
    if (native.sampleCount !== sampleCount) {
      throw new Error(
        `Native texture sample count ${native.sampleCount} does not match descriptor sample count ${sampleCount}.`
      );
    }
    return new WebGPUTexture(
      this.deviceOwner.allocateId(),
      this.deviceOwner,
      native,
      descriptor,
      adopted
    );
  }

  private assertActive(): void {
    if (this.disposed) throw new Error(`Interop scope "${this.owner}" has been disposed.`);
    if (this.deviceOwner.state !== 'live') {
      throw new Error(`Interop scope "${this.owner}" belongs to a lost WebGPUDevice.`);
    }
  }
}

function toNativeKind(kind: RHIResource['kind']): WebGPUNativeKind | undefined {
  if (kind === 'texture-view') return 'textureView';
  if (kind === 'render-pipeline') return 'renderPipeline';
  if (kind === 'compute-pipeline') return 'computePipeline';
  if (kind === 'buffer' || kind === 'texture' || kind === 'sampler' || kind === 'bind-group')
    return kind === 'bind-group' ? 'bindGroup' : kind;
  return undefined;
}
