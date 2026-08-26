import type { GPUBufferDescriptor, GPUTextureDescriptor } from '../../rhi/contracts';
import type { CompiledRenderGraph, ResourceAliasPlan } from './compiler-types';
import type { RenderGraphSnapshot } from '../builder/builder';

export type TransientAllocationDescriptor =
  | { readonly kind: 'buffer'; readonly descriptor: GPUBufferDescriptor }
  | { readonly kind: 'texture'; readonly descriptor: GPUTextureDescriptor };

export type RenderGraphExecutionStep =
  | { readonly kind: 'prelude' }
  | { readonly kind: 'pass'; readonly passId: number; readonly retainedPassIndex: number }
  | { readonly kind: 'submission' };

export interface RenderGraphExecutionPlan {
  readonly snapshot: RenderGraphSnapshot;
  readonly compiled: CompiledRenderGraph;
  readonly aliases: ResourceAliasPlan;
  readonly schedule: readonly RenderGraphExecutionStep[];
}
