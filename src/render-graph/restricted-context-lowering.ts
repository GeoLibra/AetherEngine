import type {
  GPUFragmentState,
  GPUProgrammableStage,
  GPUVertexState,
  RHIComputePipelineDescriptor,
  RHIPipelineLayout,
  RHIRenderPipelineDescriptor,
  RHIShaderModule
} from '../rhi/contracts';
import type {
  RestrictedComputePipelineDescriptor,
  RestrictedFragmentState,
  RestrictedPipelineLayout,
  RestrictedProgrammableStage,
  RestrictedRenderPipelineDescriptor,
  RestrictedShaderModule,
  RestrictedVertexState
} from './restricted-context-types';

type ResolveLayout = (layout: RestrictedPipelineLayout) => RHIPipelineLayout;
type ResolveShader = (module: RestrictedShaderModule) => RHIShaderModule;

export function lowerRestrictedRenderPipeline(
  descriptor: RestrictedRenderPipelineDescriptor,
  resolveLayout: ResolveLayout,
  resolveShader: ResolveShader
): RHIRenderPipelineDescriptor {
  const { layout, vertex, fragment, ...base } = descriptor;
  return {
    ...base,
    ...(layout === undefined ? {} : { layout: resolveLayout(layout) }),
    ...(vertex === undefined
      ? {}
      : { vertex: lowerProgrammableStage(vertex, resolveShader) as GPUVertexState }),
    ...(fragment === undefined
      ? {}
      : { fragment: lowerProgrammableStage(fragment, resolveShader) as GPUFragmentState })
  };
}

export function lowerRestrictedComputePipeline(
  descriptor: RestrictedComputePipelineDescriptor,
  resolveLayout: ResolveLayout,
  resolveShader: ResolveShader
): RHIComputePipelineDescriptor {
  const { layout, compute, ...base } = descriptor;
  return {
    ...base,
    ...(layout === undefined ? {} : { layout: resolveLayout(layout) }),
    ...(compute === undefined ? {} : { compute: lowerProgrammableStage(compute, resolveShader) })
  };
}

function lowerProgrammableStage(
  stage: RestrictedVertexState | RestrictedFragmentState | RestrictedProgrammableStage,
  resolveShader: ResolveShader
): GPUProgrammableStage {
  return { ...stage, module: resolveShader(stage.module) };
}
