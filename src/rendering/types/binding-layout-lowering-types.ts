import type { GPUBindGroupLayoutDescriptor } from '../../rhi';
import type { BindingLayoutId, BindingLocation } from './binding-layout-types';

export type BindingLayoutLoweringTarget = 'webgpu' | 'webgl2';

export interface BindingLayoutLoweringOptions {
  readonly maxBindGroups?: number;
  readonly maxBindingsPerGroup?: number;
  readonly maxTextureUnits?: number;
  readonly allowWebGl2StorageBuffers?: boolean;
}

export interface WebGpuBindingLayoutPlan {
  readonly kind: 'webgpu';
  readonly layout: BindingLayoutId;
  readonly groups: readonly Readonly<{
    group: number;
    descriptor: GPUBindGroupLayoutDescriptor;
  }>[];
  readonly dynamicOffsetOrder: readonly BindingLocation[];
}

export interface WebGl2BindingLayoutPlan {
  readonly kind: 'webgl2';
  readonly layout: BindingLayoutId;
  readonly uniformBlocks: readonly Readonly<BindingLocation & { byteSize: number }>[];
  readonly storageBuffers: readonly Readonly<
    BindingLocation & { byteSize: number; access: 'read' | 'read_write' }
  >[];
  readonly textures: readonly Readonly<
    BindingLocation & {
      textureUnit: number;
      viewDimension: '2d' | 'cube';
      sampleType: 'float' | 'depth';
      multisampled: boolean;
    }
  >[];
  readonly samplers: readonly Readonly<
    BindingLocation & {
      textureUnit: number;
      samplerType: 'filtering' | 'non-filtering' | 'comparison';
    }
  >[];
  readonly dynamicOffsetOrder: readonly BindingLocation[];
}

export type BindingLayoutUnsupportedCode =
  | 'bind-group-limit-exceeded'
  | 'bindings-per-group-limit-exceeded'
  | 'texture-unit-limit-exceeded'
  | 'storage-buffer-unsupported';

export interface BindingLayoutUnsupported {
  readonly kind: 'unsupported';
  readonly target: BindingLayoutLoweringTarget;
  readonly diagnostic: Readonly<{
    code: BindingLayoutUnsupportedCode;
    message: string;
    group?: number;
    binding?: number;
  }>;
}

export type BindingLayoutLoweringResult =
  WebGpuBindingLayoutPlan | WebGl2BindingLayoutPlan | BindingLayoutUnsupported;
