import {
  featureId,
  hostServiceId,
  implementationId,
  snapshotResourceBudget,
  type ResourceBudget,
  type RenderFeatureImplementation,
  type RuntimeFeatureImplementation
} from '../../../feature-policy';
import { buildCpuLightLists } from './light-list';
import type { ComputePassContext, RasterPassContext } from '../../../render-graph';
import type {
  CpuLightListCapacity,
  CpuLightListResult,
  LightReceiver,
  PreparedLight,
  WebGlFragmentLightListBuildContext,
  WebGlFragmentLightListBuildOutput,
  WebGpuLightListBuildContext,
  WebGpuLightListBuildOutput
} from '../types';
import { calculateWebGlLightListPacking } from './light-list-packing';
import {
  LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS,
  LIGHT_LIST_SHADER_MAX_INDICES,
  LIGHT_LIST_SHADER_MAX_RECEIVERS
} from './light-list-abi';

export const BuiltInFeature = Object.freeze({
  LightListBuild: featureId('aether.rendering.light-list-build')
} as const);

export const BuiltInFeatureImplementation = Object.freeze({
  WebGpuComputeLightList: implementationId('webgpu-compute'),
  WebGlFragmentLightList: implementationId('webgl-fragment'),
  CpuBoundedLightList: implementationId('cpu-bounded')
} as const);

export const BuiltInHostService = Object.freeze({
  MainCpu: hostServiceId('main-cpu')
} as const);

export interface CpuBoundedLightListFrameInput {
  readonly viewLayerMask: number;
  readonly lights: readonly PreparedLight[];
  readonly receivers: readonly LightReceiver[];
}

export interface CpuBoundedLightListImplementationOptions {
  readonly capacity: CpuLightListCapacity;
  readonly estimatedBudget: ResourceBudget;
}

export interface GpuLightListImplementationOptions {
  readonly capacity: CpuLightListCapacity;
  readonly estimatedBudget: ResourceBudget;
}

export interface WebGlFragmentLightListImplementationOptions extends GpuLightListImplementationOptions {
  readonly maxTextureDimension2D: number;
}

/** Creates the WebGPU graph contribution seam selected from negotiated compute capabilities. */
export function createWebGpuComputeLightListImplementation(
  options: GpuLightListImplementationOptions
): RenderFeatureImplementation<CpuLightListCapacity, WebGpuLightListBuildContext> {
  const capacity = snapshotCapacity(options.capacity);
  validateShaderCapacity(capacity);
  const estimatedBudget = snapshotResourceBudget(options.estimatedBudget);
  return {
    kind: 'render',
    feature: BuiltInFeature.LightListBuild,
    id: BuiltInFeatureImplementation.WebGpuComputeLightList,
    version: 1,
    support: 'native',
    semanticContract: 'aether.light-list-build@1',
    requirements: [
      { kind: 'feature', feature: 'compute', statuses: ['native'] },
      { kind: 'feature', feature: 'storage-buffer', statuses: ['native'] },
      { kind: 'queue', role: 'compute', statuses: ['native'] }
    ],
    dependencies: [],
    conflicts: [],
    cacheDomains: ['shader-pipeline'],
    priority: 20,
    quality: {
      tier: 'gpu-compute',
      rank: 20,
      notes: ['Compute graph seam with explicit bounded storage outputs; recorder owns execution.']
    },
    estimate: () => estimatedBudget,
    prepare: async () => capacity,
    dispose: () => undefined,
    contribute: (prepared, context) => contributeWebGpuLightList(prepared, context)
  };
}

/** Creates the WebGL2 integer-MRT graph seam without changing RHI compute support. */
export function createWebGlFragmentLightListImplementation(
  options: WebGlFragmentLightListImplementationOptions
): RenderFeatureImplementation<CpuLightListCapacity, WebGlFragmentLightListBuildContext> {
  const capacity = snapshotCapacity(options.capacity);
  const estimatedBudget = snapshotResourceBudget(options.estimatedBudget);
  const maxTextureDimension2D = options.maxTextureDimension2D;
  calculateWebGlLightListPacking(0, capacity, maxTextureDimension2D);
  return {
    kind: 'render',
    feature: BuiltInFeature.LightListBuild,
    id: BuiltInFeatureImplementation.WebGlFragmentLightList,
    version: 1,
    support: 'emulated',
    semanticContract: 'aether.light-list-build@1',
    requirements: [
      { kind: 'format', format: 'rgba32uint', capability: 'render' },
      { kind: 'format', format: 'rgba32uint', capability: 'sample' },
      { kind: 'limit', limit: 'maxColorAttachments', minimum: 4 },
      { kind: 'limit', limit: 'maxTextureDimension2D', minimum: maxTextureDimension2D },
      { kind: 'queue', role: 'graphics', statuses: ['native', 'emulated'] }
    ],
    dependencies: [],
    conflicts: [],
    cacheDomains: ['shader-pipeline'],
    priority: 10,
    quality: {
      tier: 'fragment-emulated',
      rank: 10,
      notes: ['Integer MRT graph packing is explicit; recorder owns fragment execution.']
    },
    estimate: () => estimatedBudget,
    prepare: async () => capacity,
    dispose: () => undefined,
    contribute: (prepared, context) =>
      contributeWebGlFragmentLightList(prepared, maxTextureDimension2D, context)
  };
}

export function createCpuBoundedLightListImplementation(
  options: CpuBoundedLightListImplementationOptions
): RuntimeFeatureImplementation<
  CpuLightListCapacity,
  CpuBoundedLightListFrameInput,
  CpuLightListResult
> {
  const capacity = snapshotCapacity(options.capacity);
  const estimatedBudget = snapshotResourceBudget(options.estimatedBudget);
  return {
    kind: 'runtime' as const,
    feature: BuiltInFeature.LightListBuild,
    id: BuiltInFeatureImplementation.CpuBoundedLightList,
    version: 1,
    support: 'fallback' as const,
    semanticContract: 'aether.light-list-build@1',
    requirements: [
      {
        kind: 'queue' as const,
        role: 'graphics' as const,
        statuses: ['native', 'emulated'] as const
      },
      { kind: 'service' as const, service: BuiltInHostService.MainCpu }
    ],
    dependencies: [],
    conflicts: [],
    cacheDomains: ['shader-pipeline'],
    priority: 0,
    quality: {
      tier: 'cpu-bounded',
      rank: 0,
      notes: ['Capacity and deterministic truncation are explicit.']
    },
    estimate: () => estimatedBudget,
    prepare: async () => capacity,
    dispose: () => undefined,
    execute: (prepared: CpuLightListCapacity, frame: CpuBoundedLightListFrameInput) =>
      buildCpuLightLists({
        viewLayerMask: frame.viewLayerMask,
        lights: frame.lights,
        receivers: frame.receivers,
        capacity: prepared
      })
  };
}

function contributeWebGpuLightList(
  capacity: CpuLightListCapacity,
  context: WebGpuLightListBuildContext
): void {
  const record = context.recorder?.record;
  const publish = context.publish;
  validateBuildContext(context.viewId, context.input.receiverCount, record, publish);
  if (context.input.receiverCount > LIGHT_LIST_SHADER_MAX_RECEIVERS)
    throw new Error('WebGPU light-list receiver count exceeds the built-in shader maximum.');
  const directionalIndices = context.graph.createBuffer({
    label: `${context.viewId}:light-list-directional`,
    size: LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS * 4,
    usage: ['storage-write', 'storage-read', 'uniform', 'copy-src']
  });
  const headers = context.graph.createBuffer({
    label: `${context.viewId}:light-list-headers`,
    size: LIGHT_LIST_SHADER_MAX_RECEIVERS * 16,
    usage: ['storage-write', 'storage-read', 'uniform', 'copy-src']
  });
  const lightIndices = context.graph.createBuffer({
    label: `${context.viewId}:light-list-indices`,
    size: LIGHT_LIST_SHADER_MAX_INDICES * 4,
    usage: ['storage-write', 'storage-read', 'uniform', 'copy-src']
  });
  const overflow = context.graph.createBuffer({
    label: `${context.viewId}:light-list-overflow`,
    size: 16,
    usage: ['storage-write', 'storage-read', 'uniform', 'copy-src']
  });
  let published: WebGpuLightListBuildOutput | undefined;
  context.graph.addComputePass({
    id: `light-list:webgpu-compute:${context.viewId}`,
    setup(pass) {
      pass.useComputePipeline(context.recorder.pipeline);
      const input = Object.freeze({
        lights: pass.readBuffer(context.input.lights, 'storage-read'),
        receivers: pass.readBuffer(context.input.receivers, 'storage-read'),
        receiverCount: context.input.receiverCount
      });
      const output = Object.freeze({
        source: 'gpu-compute' as const,
        directionalIndices: pass.writeBuffer(directionalIndices, 'storage-write'),
        headers: pass.writeBuffer(headers, 'storage-write'),
        lightIndices: pass.writeBuffer(lightIndices, 'storage-write'),
        overflow: pass.writeBuffer(overflow, 'storage-write'),
        capacity
      });
      published = output;
      pass.sideEffect('build WebGPU light lists');
      return Object.freeze({ input, output });
    },
    run(passContext: ComputePassContext, resources) {
      record(passContext, resources.input, resources.output);
    }
  });
  if (published === undefined)
    throw new Error('WebGPU light-list pass did not publish its outputs.');
  publish(published);
}

function contributeWebGlFragmentLightList(
  capacity: CpuLightListCapacity,
  maxTextureDimension2D: number,
  context: WebGlFragmentLightListBuildContext
): void {
  const record = context.recorder?.record;
  const publish = context.publish;
  validateBuildContext(context.viewId, context.input.receiverCount, record, publish);
  const packing = calculateWebGlLightListPacking(
    context.input.receiverCount,
    capacity,
    maxTextureDimension2D
  );
  const createOutput = (label: string) =>
    context.graph.createTexture({
      label: `${context.viewId}:${label}`,
      width: packing.width,
      height: packing.height,
      depthOrArrayLayers: 1,
      mipLevelCount: 1,
      sampleCount: 1,
      format: 'rgba32uint',
      usage: ['color-attachment', 'sampled', 'copy-src']
    });
  // WebGL2 requires every attachment in one MRT pass to have the same extent.
  const directionalIndices = createOutput('light-list-directional');
  const headers = createOutput('light-list-headers');
  const lightIndices = createOutput('light-list-indices');
  const overflow = createOutput('light-list-overflow');
  let published: WebGlFragmentLightListBuildOutput | undefined;
  context.graph.addRasterPass({
    id: `light-list:webgl-fragment:${context.viewId}`,
    setup(pass) {
      pass.useRenderPipeline(context.recorder.pipeline);
      const input = Object.freeze({
        lights: pass.readTexture(context.input.lights, 'sampled'),
        receivers: pass.readTexture(context.input.receivers, 'sampled'),
        receiverCount: context.input.receiverCount
      });
      const attachmentOptions = Object.freeze({
        load: 'clear' as const,
        store: 'store' as const,
        clearValue: { r: 0, g: 0, b: 0, a: 0 }
      });
      const output = Object.freeze({
        source: 'webgl-fragment' as const,
        directionalIndices: pass.colorAttachment(0, directionalIndices, attachmentOptions),
        headers: pass.colorAttachment(1, headers, attachmentOptions),
        lightIndices: pass.colorAttachment(2, lightIndices, attachmentOptions),
        overflow: pass.colorAttachment(3, overflow, attachmentOptions),
        capacity,
        packing
      });
      published = output;
      pass.sideEffect('build WebGL2 fragment light lists');
      return Object.freeze({ input, output });
    },
    run(passContext: RasterPassContext, resources) {
      record(passContext, resources.input, resources.output);
    }
  });
  if (published === undefined)
    throw new Error('WebGL2 fragment light-list pass did not publish its outputs.');
  publish(published);
}

function validateBuildContext(
  viewId: string,
  receiverCount: number,
  record: unknown,
  publish: unknown
): asserts record is WebGpuLightListBuildContext['recorder']['record'] {
  if (!viewId.trim()) throw new Error('Light-list build view id must be non-empty.');
  if (!Number.isSafeInteger(receiverCount) || receiverCount < 0) {
    throw new Error('Light-list receiver count must be a non-negative integer.');
  }
  if (typeof record !== 'function') throw new Error('Light-list build requires a recorder.');
  if (typeof publish !== 'function')
    throw new Error('Light-list build requires a publish callback.');
}

function validateShaderCapacity(capacity: CpuLightListCapacity): void {
  if (
    capacity.maxDirectionalLights > LIGHT_LIST_SHADER_MAX_DIRECTIONAL_LIGHTS ||
    capacity.maxLightIndices > LIGHT_LIST_SHADER_MAX_INDICES
  )
    throw new Error('WebGPU light-list capacity exceeds the built-in shader ABI maximum.');
}

function snapshotCapacity(capacity: CpuLightListCapacity): CpuLightListCapacity {
  for (const [name, value] of Object.entries(capacity)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`CPU bounded light-list ${name} must be a non-negative integer.`);
    }
  }
  return { ...capacity };
}
