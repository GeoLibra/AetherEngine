import type {
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIComputePipeline,
  RHIDevice,
  RHIPipelineLayout,
  RHIRenderPipeline,
  RHISampler,
  RHIShaderModule
} from '../../rhi/contracts';
import type {
  RestrictedBindGroup,
  RestrictedBindGroupDescriptor,
  RestrictedBindGroupEntry,
  RestrictedBindGroupLayout,
  RestrictedComputePipeline,
  RestrictedPipelineLayout,
  RestrictedPortableDevice,
  RestrictedRenderPipeline,
  RestrictedSampler,
  RestrictedShaderModule
} from '../types';
import type { RestrictedResourceOwner } from './restricted-resource-owner';
import {
  lowerRestrictedComputePipeline,
  lowerRestrictedRenderPipeline
} from './restricted-context-lowering';

export interface DeviceFactoryContext {
  readonly rhiDevice: RHIDevice;
  readonly resourceOwner: RestrictedResourceOwner;
  readonly samplers: WeakMap<RestrictedSampler, RHISampler>;
  readonly shaderModules: WeakMap<RestrictedShaderModule, RHIShaderModule>;
  readonly bindGroupLayouts: WeakMap<RestrictedBindGroupLayout, RHIBindGroupLayout>;
  readonly pipelineLayouts: WeakMap<RestrictedPipelineLayout, RHIPipelineLayout>;
  readonly bindGroups: WeakMap<RestrictedBindGroup, RHIBindGroup>;
  readonly renderPipelines: WeakMap<RestrictedRenderPipeline, RHIRenderPipeline>;
  readonly computePipelines: WeakMap<RestrictedComputePipeline, RHIComputePipeline>;
  readonly requireOpen: (action: string) => void;
  readonly bindingResource: (resource: RestrictedBindGroupEntry['resource']) => unknown;
}

export function createRestrictedPortableDevice(
  ctx: DeviceFactoryContext
): RestrictedPortableDevice {
  const {
    rhiDevice,
    resourceOwner,
    samplers,
    shaderModules,
    bindGroupLayouts,
    pipelineLayouts,
    bindGroups,
    renderPipelines,
    computePipelines,
    requireOpen,
    bindingResource
  } = ctx;

  const device: RestrictedPortableDevice = {
    capabilities: rhiDevice.capabilities,
    generation: rhiDevice.generation,
    state: rhiDevice.state,
    lost: rhiDevice.lost,
    createSampler: (descriptor) => {
      requireOpen('create a sampler');
      const raw = resourceOwner.own(rhiDevice.createSampler(descriptor));
      const capability = Object.freeze({ kind: 'restricted-sampler' as const });
      samplers.set(capability, raw);
      return capability;
    },
    createShaderModule: (descriptor) => {
      requireOpen('create a shader module');
      const raw = resourceOwner.own(rhiDevice.createShaderModule(descriptor));
      const capability = Object.freeze({ kind: 'restricted-shader-module' as const });
      shaderModules.set(capability, raw);
      return capability;
    },
    createBindGroupLayout: (descriptor) => {
      const raw = resourceOwner.create('create a bind group layout', () =>
        rhiDevice.createBindGroupLayout(descriptor)
      );
      const capability = Object.freeze({ kind: 'restricted-bind-group-layout' as const });
      bindGroupLayouts.set(capability, raw);
      return capability;
    },
    createPipelineLayout: (descriptor) => {
      requireOpen('create a pipeline layout');
      const raw = resourceOwner.own(
        rhiDevice.createPipelineLayout({
          ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
          bindGroupLayouts: descriptor.bindGroupLayouts.map((layout) =>
            requiredCapability(
              bindGroupLayouts,
              layout,
              'Bind group layout is not owned by this render graph pass.'
            )
          )
        })
      );
      const capability = Object.freeze({ kind: 'restricted-pipeline-layout' as const });
      pipelineLayouts.set(capability, raw);
      return capability;
    },
    createBindGroup: (descriptor: RestrictedBindGroupDescriptor) => {
      requireOpen('create a bind group');
      const entries = descriptor.entries.map((entry) => ({
        binding: entry.binding,
        resource: bindingResource(entry.resource) as any
      }));
      const bindGroup = resourceOwner.own(
        rhiDevice.createBindGroup({
          ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
          layout: requiredCapability(
            bindGroupLayouts,
            descriptor.layout,
            'Bind group layout is not owned by this render graph pass.'
          ),
          entries
        })
      );
      const capability = Object.freeze({ kind: 'restricted-bind-group' as const });
      bindGroups.set(capability, bindGroup);
      return capability;
    },
    createRenderPipeline: (descriptor) => {
      const raw = resourceOwner.create('create a render pipeline', () =>
        rhiDevice.createRenderPipeline(
          lowerRestrictedRenderPipeline(
            descriptor,
            (layout) =>
              requiredCapability(
                pipelineLayouts,
                layout,
                'Pipeline layout is not owned by this render graph pass.'
              ),
            (module) =>
              requiredCapability(
                shaderModules,
                module,
                'Shader module is not owned by this render graph pass.'
              )
          )
        )
      );
      const capability = Object.freeze({ kind: 'restricted-render-pipeline' as const });
      renderPipelines.set(capability, raw);
      return capability;
    },
    createComputePipeline: (descriptor = {}) => {
      const raw = resourceOwner.create('create a compute pipeline', () =>
        rhiDevice.createComputePipeline(
          lowerRestrictedComputePipeline(
            descriptor,
            (layout) =>
              requiredCapability(
                pipelineLayouts,
                layout,
                'Pipeline layout is not owned by this render graph pass.'
              ),
            (module) =>
              requiredCapability(
                shaderModules,
                module,
                'Shader module is not owned by this render graph pass.'
              )
          )
        )
      );
      const capability = Object.freeze({ kind: 'restricted-compute-pipeline' as const });
      computePipelines.set(capability, raw);
      return capability;
    }
  };

  return Object.freeze(device);
}

function requiredCapability<K extends object, V>(
  capabilities: WeakMap<K, V>,
  capability: K,
  message: string
): V {
  const raw = capabilities.get(capability);
  if (raw === undefined) throw new Error(message);
  return raw;
}
