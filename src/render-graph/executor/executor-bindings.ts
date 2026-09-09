import type { GraphHandle } from '../types';
import type { GraphResourceRecord } from '../builder/resources';
import type { RenderGraphSnapshot } from '../builder/builder';
import type { CompiledRenderGraph } from '../types';
import type { RenderGraphExecutionPlan } from '../types';
import type { AcquiredHistorySlot, HistoryIdentity, HistoryRegistry } from '../compiler/history';
import type { RenderGraphHistoryDebugBinding } from '../compiler/debug-ir';
import type {
  RHIBuffer,
  RHIDevice,
  RHIRenderPipeline,
  RHISubmission,
  RHITexture
} from '../../rhi/contracts';
import type { RHISurface, RHISurfaceFrame } from '../../rhi/contracts/surface';
import { allocationFor } from './executor-resource-utils';
import { TransientResourcePool, type TransientResource } from './transient-pool';
import type {
  PreparedBindGroupLayoutBindings,
  PreparedComputePipelineBindings,
  PreparedDrawResourcesBindings,
  PreparedRenderPipelineBindings
} from '../builder/prepared-resources';

export interface RenderGraphHistoryBinding extends AcquiredHistorySlot {
  readonly registry: HistoryRegistry;
  readonly identity: HistoryIdentity;
}

export interface RenderGraphExecutionInputs {
  readonly device: RHIDevice;
  /** Physical resources for imported and history graph resources, keyed by their version-zero handle. */
  readonly resources?: ReadonlyMap<GraphHandle, RHITexture | RHIBuffer>;
  /** Acquired registry slots, keyed by the history resource's version-zero handle. */
  readonly histories?: ReadonlyMap<GraphHandle, RenderGraphHistoryBinding>;
  /** Single-surface convenience for plans with one present terminal. */
  readonly surface?: RHISurface;
  /** Explicit surface selection for plans containing more than one frame token. */
  readonly surfaces?: ReadonlyMap<string, RHISurface>;
  /** A shared pool maintains transient reuse only after the submission terminates. */
  readonly transientPool?: TransientResourcePool;
  /** Externally owned pipelines prepared before surface acquisition. */
  readonly preparedRenderPipelines?: PreparedRenderPipelineBindings;
  /** Externally owned compute pipelines prepared before surface acquisition. */
  readonly preparedComputePipelines?: PreparedComputePipelineBindings;
  /** Externally owned bind-group layouts used to bind graph resources to prepared pipelines. */
  readonly preparedBindGroupLayouts?: PreparedBindGroupLayoutBindings;
  /** Submission-safe indexed draw packets prepared before surface acquisition. */
  readonly preparedDrawResources?: PreparedDrawResourcesBindings;
}

export interface SurfaceBinding {
  readonly frame: RHISurfaceFrame;
  readonly resourceId: number;
}

export function validatePreparedRenderPipelines(inputs: RenderGraphExecutionInputs): void {
  for (const [token, pipeline] of inputs.preparedRenderPipelines ?? []) {
    if (token.kind !== 'prepared-render-pipeline-token') {
      throw new TypeError('Prepared render pipeline binding has an invalid token.');
    }
    if (pipeline.state !== 'live') {
      throw new Error(`Prepared render pipeline "${token.name}" is not a live resource.`);
    }
    if (pipeline.generation !== inputs.device.generation) {
      throw new Error(
        `Prepared render pipeline "${token.name}" belongs to another device generation.`
      );
    }
  }
}

export function validatePreparedComputePipelines(inputs: RenderGraphExecutionInputs): void {
  for (const [token, pipeline] of inputs.preparedComputePipelines ?? []) {
    if (token.kind !== 'prepared-compute-pipeline-token') {
      throw new TypeError('Prepared compute pipeline binding has an invalid token.');
    }
    if (pipeline.state !== 'live') {
      throw new Error(`Prepared compute pipeline "${token.name}" is not a live resource.`);
    }
    if (pipeline.generation !== inputs.device.generation) {
      throw new Error(
        `Prepared compute pipeline "${token.name}" belongs to another device generation.`
      );
    }
  }
}

export function validatePreparedBindGroupLayouts(inputs: RenderGraphExecutionInputs): void {
  for (const [token, layout] of inputs.preparedBindGroupLayouts ?? []) {
    if (token.kind !== 'prepared-bind-group-layout-token') {
      throw new TypeError('Prepared bind-group layout binding has an invalid token.');
    }
    if (layout.state !== 'live') {
      throw new Error(`Prepared bind-group layout "${token.name}" is not a live resource.`);
    }
    if (layout.generation !== inputs.device.generation) {
      throw new Error(
        `Prepared bind-group layout "${token.name}" belongs to another device generation.`
      );
    }
  }
}

export function validatePreparedDrawResources(inputs: RenderGraphExecutionInputs): void {
  const packets = new Set<object>();
  for (const [token, packet] of inputs.preparedDrawResources ?? []) {
    if (token.kind !== 'prepared-draw-resources-token')
      throw new TypeError('Prepared draw resource binding has an invalid token.');
    if (!packet.retentionReady)
      throw new Error(`Prepared draw resources "${token.name}" cannot be retained.`);
    if (!packets.add(packet))
      throw new Error('One prepared draw packet cannot be bound to multiple resource tokens.');
    if (packet.bindingSet.deviceGeneration !== inputs.device.generation)
      throw new Error(
        `Prepared draw resources "${token.name}" belong to another device generation.`
      );
    for (const resource of [
      packet.pipeline,
      ...packet.bindingSet.bindGroups,
      ...packet.vertexBuffers,
      packet.indexBuffer
    ]) {
      if (resource.state !== 'live')
        throw new Error(`Prepared draw resources "${token.name}" contain a non-live resource.`);
      if (resource.generation !== inputs.device.generation)
        throw new Error(
          `Prepared draw resources "${token.name}" belong to another device generation.`
        );
    }
  }
}

/** Validates declared prepared tokens and their attachment compatibility before surface acquire. */
export function validateRasterGroupBindings(
  plan: RenderGraphExecutionPlan,
  inputs: RenderGraphExecutionInputs
): void {
  for (const group of plan.rasterGroups) {
    for (const retainedPassIndex of group.retainedPassIndices) {
      const pass = plan.compiled.retainedPasses[retainedPassIndex]!;
      const details = pass.rasterDetails!;
      for (const token of details.preparedRenderPipelines) {
        const pipeline = inputs.preparedRenderPipelines?.get(token);
        if (pipeline === undefined) {
          throw new Error(`Prepared render pipeline "${token.name}" is not bound.`);
        }
        validatePipelineAttachments(pass.id, pipeline, group, plan.snapshot);
      }
      for (const token of details.preparedDrawResources) {
        const packet = inputs.preparedDrawResources?.get(token);
        if (packet === undefined) {
          throw new Error(`Prepared draw resources "${token.name}" are not bound.`);
        }
        validatePipelineAttachments(pass.id, packet.pipeline, group, plan.snapshot);
      }
    }
  }
}

function validatePipelineAttachments(
  passId: string,
  pipeline: RHIRenderPipeline,
  group: RenderGraphExecutionPlan['rasterGroups'][number],
  snapshot: RenderGraphSnapshot
): void {
  const colors = [...group.attachments.colorAttachments].sort(
    (first, second) => first.slot - second.slot
  );
  const targets = pipeline.descriptor.fragment?.targets;
  if (targets !== undefined && targets.length !== colors.length) {
    throw new Error(
      `Raster pass "${passId}" pipeline color target count is incompatible with its physical attachments.`
    );
  }
  for (let index = 0; targets !== undefined && index < colors.length; index++) {
    const color = colors[index]!;
    const resource = snapshot.resources[color.resourceId];
    if (resource?.kind !== 'texture' || targets[index]?.format !== resource.descriptor.format) {
      throw new Error(
        `Raster pass "${passId}" pipeline color target ${index} is incompatible with its physical attachment.`
      );
    }
  }
  const depth = group.attachments.depthStencilAttachment;
  const pipelineDepth = pipeline.descriptor.depthStencil;
  if (depth === undefined && pipelineDepth !== undefined) {
    throw new Error(
      `Raster pass "${passId}" pipeline depth/stencil state is incompatible with its physical attachments.`
    );
  }
  if (depth !== undefined && pipelineDepth !== undefined) {
    const resource = snapshot.resources[depth.resourceId];
    if (resource?.kind !== 'texture' || pipelineDepth?.format !== resource.descriptor.format) {
      throw new Error(
        `Raster pass "${passId}" pipeline depth/stencil format is incompatible with its physical attachment.`
      );
    }
  }
  const attachmentSampleCount =
    colors.length > 0
      ? (snapshot.resources[colors[0]!.resourceId]?.descriptor as { sampleCount?: number })
          .sampleCount ?? 1
      : depth !== undefined
        ? (snapshot.resources[depth.resourceId]?.descriptor as { sampleCount?: number }).sampleCount ??
          1
        : 1;
  if ((pipeline.descriptor.multisample?.count ?? 1) !== attachmentSampleCount) {
    throw new Error(
      `Raster pass "${passId}" pipeline sample count is incompatible with its physical attachments.`
    );
  }
}

export function transferPreparedDrawResources(
  inputs: RenderGraphExecutionInputs,
  submission: RHISubmission
): void {
  for (const packet of inputs.preparedDrawResources?.values() ?? []) {
    packet.retain(submission);
    packet.release();
  }
}

export function resolveResources(
  plan: RenderGraphExecutionPlan,
  inputs: RenderGraphExecutionInputs,
  frames: readonly SurfaceBinding[],
  pool: TransientResourcePool,
  transients: TransientResource[]
): ReadonlyMap<GraphHandle, RHITexture | RHIBuffer> {
  const { snapshot, compiled } = plan;
  const physical = new Map<GraphHandle, RHITexture | RHIBuffer>();
  const physicalAliases = new Map<number, TransientResource>();
  const frameResources = new Map(
    frames.map((binding) => [binding.resourceId, binding.frame.texture])
  );
  const retainedResourceIds = collectRetainedResourceIds(compiled);
  for (const resource of snapshot.resources) {
    if (!retainedResourceIds.has(resource.resourceId)) continue;
    const frame = frameResources.get(resource.resourceId);
    if (frame !== undefined) {
      bindAllVersions(physical, resource, frame);
      continue;
    }
    if (resource.origin.kind === 'transient') {
      const decision = plan.aliases.decisions.find(
        (candidate) => candidate.resourceId === resource.resourceId
      );
      if (decision?.allocationId === null || decision === undefined) {
        throw new Error(
          `Render graph transient resource ${resource.resourceId} has no allocation.`
        );
      }
      let transient = physicalAliases.get(decision.allocationId);
      if (transient === undefined) {
        transient = pool.acquire(allocationFor(resource));
        physicalAliases.set(decision.allocationId, transient);
        transients.push(transient);
      }
      bindAllVersions(physical, resource, transient);
      continue;
    }
    if (resource.origin.kind === 'history') {
      const handle = resource.versions[0]?.handle as GraphHandle;
      const binding = inputs.histories?.get(handle);
      if (binding === undefined) {
        throw new Error(
          `Render graph history resource ${resource.resourceId} requires an acquired history binding.`
        );
      }
      validateHistoryBinding(resource, binding, inputs.device);
      bindHistoryVersions(physical, resource, binding);
      continue;
    }
    const imported = inputs.resources?.get(resource.versions[0]?.handle as GraphHandle);
    if (imported === undefined) {
      throw new Error(
        `Render graph ${resource.origin.kind} resource ${resource.resourceId} has no physical binding.`
      );
    }
    if (imported.kind !== resource.kind) {
      throw new Error(
        `Render graph resource ${resource.resourceId} physical binding kind does not match.`
      );
    }
    validatePhysicalBinding(resource, imported, inputs.device);
    bindAllVersions(physical, resource, imported);
  }
  return physical;
}

export function validatePhysicalBinding(
  resource: RenderGraphSnapshot['resources'][number],
  physical: RHITexture | RHIBuffer,
  device: RHIDevice
): void {
  if (physical.kind !== resource.kind || physical.state !== 'live') {
    throw new Error('Render graph physical binding is not a live resource of the declared kind.');
  }
  if (physical.generation !== device.generation) {
    throw new Error('Render graph physical binding belongs to a different device generation.');
  }
  const actual =
    physical.kind === 'buffer'
      ? { kind: 'buffer' as const, descriptor: physical.descriptor }
      : { kind: 'texture' as const, descriptor: physical.descriptor };
  if (!descriptorsEqual(allocationFor(resource), actual, true)) {
    throw new Error(
      'Render graph physical binding descriptor is incompatible with the graph resource.'
    );
  }
}

export function commitHistoryBindings(
  plan: RenderGraphExecutionPlan,
  inputs: RenderGraphExecutionInputs,
  submission: RHISubmission
): void {
  for (const resource of retainedHistoryResources(plan)) {
    const handle = resource.versions[0]?.handle as GraphHandle;
    const binding = inputs.histories?.get(handle);
    if (binding === undefined)
      throw new Error('Render graph history binding disappeared before submit.');
    const written = plan.compiled.retainedPasses.some((pass) =>
      pass.accesses.some(
        (access) => access.kind === 'write' && access.handle.resourceId === resource.resourceId
      )
    );
    const readPrevious = plan.compiled.retainedPasses.some((pass) =>
      pass.accesses.some(
        (access) =>
          access.kind === 'read' &&
          access.handle.resourceId === resource.resourceId &&
          access.handle.version === 0
      )
    );
    if (readPrevious && binding.readable !== undefined) {
      binding.registry.retain(binding.identity, binding.readable.slot, submission);
    }
    if (written) binding.registry.publish(binding.identity, binding, submission);
    else binding.registry.abandon(binding.identity, binding);
  }
}

export function historyDebugStates(
  plan: RenderGraphExecutionPlan,
  inputs: RenderGraphExecutionInputs
): ReadonlyMap<number, RenderGraphHistoryDebugBinding> {
  const states = new Map<number, RenderGraphHistoryDebugBinding>();
  for (const resource of retainedHistoryResources(plan)) {
    const binding = inputs.histories?.get(resource.versions[0]?.handle as GraphHandle);
    if (binding === undefined) continue;
    states.set(resource.resourceId, {
      readableSlot: binding.readable?.slot,
      writableSlot: binding.writable.slot,
      versionSlots: resource.versions.map((version) => ({
        version: version.version,
        slot: version.version === 0 ? binding.readable?.slot : binding.writable.slot
      })),
      slots: binding.registry.debugState(binding.identity)
    });
  }
  return states;
}

export function abandonHistoryBindings(
  plan: RenderGraphExecutionPlan,
  inputs: RenderGraphExecutionInputs
): void {
  for (const resource of retainedHistoryResources(plan)) {
    const binding = inputs.histories?.get(resource.versions[0]?.handle as GraphHandle);
    if (binding === undefined) continue;
    try {
      binding.registry.abandon(binding.identity, binding);
    } catch {
      // Cleanup is best effort and must not replace the execution failure.
    }
  }
}

function validateHistoryBinding(
  resource: RenderGraphSnapshot['resources'][number],
  binding: RenderGraphHistoryBinding,
  device: RHIDevice
): void {
  if (
    resource.origin.kind !== 'history' ||
    binding.identity.key !== resource.origin.key ||
    binding.identity.slots !== resource.origin.slots
  ) {
    throw new Error('Render graph history binding identity does not match its logical origin.');
  }
  if (binding.identity.deviceGeneration !== device.generation) {
    throw new Error('Render graph history binding belongs to a different device generation.');
  }
  binding.registry.assertAcquiredBinding(binding.identity, binding);
  if ((binding.readable !== undefined) !== resource.historyValid) {
    throw new Error('Render graph history validity does not match the acquired registry slot.');
  }
  if (!descriptorsEqual(allocationFor(resource), binding.identity.descriptor)) {
    throw new Error(
      'Render graph history binding descriptor is incompatible with the graph resource.'
    );
  }
  validateHistoryPhysical(resource, binding.writable.handle, device);
  if (binding.readable !== undefined) {
    validateHistoryPhysical(resource, binding.readable.handle, device);
  }
}

function validateHistoryPhysical(
  resource: RenderGraphSnapshot['resources'][number],
  physical: RHITexture | RHIBuffer,
  device: RHIDevice
): void {
  if (physical.generation !== device.generation) {
    throw new Error(
      'Render graph history physical resource belongs to a different device generation.'
    );
  }
  if (physical.kind !== resource.kind || physical.state !== 'live') {
    throw new Error('Render graph history binding is not a live resource of the declared kind.');
  }
}

function descriptorsEqual(
  expected: ReturnType<typeof allocationFor>,
  actual: ReturnType<typeof allocationFor>,
  allowUsageSuperset = false
): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === 'buffer' && actual.kind === 'buffer') {
    return (
      expected.descriptor.size === actual.descriptor.size &&
      usageMatches(expected.descriptor.usage, actual.descriptor.usage, allowUsageSuperset)
    );
  }
  if (expected.kind === 'texture' && actual.kind === 'texture') {
    const left = normalizedExtent(expected.descriptor.size);
    const right = normalizedExtent(actual.descriptor.size);
    return (
      left.width === right.width &&
      left.height === right.height &&
      left.depthOrArrayLayers === right.depthOrArrayLayers &&
      expected.descriptor.format === actual.descriptor.format &&
      usageMatches(expected.descriptor.usage, actual.descriptor.usage, allowUsageSuperset) &&
      (expected.descriptor.mipLevelCount ?? 1) === (actual.descriptor.mipLevelCount ?? 1) &&
      (expected.descriptor.sampleCount ?? 1) === (actual.descriptor.sampleCount ?? 1)
    );
  }
  return false;
}

function usageMatches(expected: number, actual: number, allowSuperset: boolean): boolean {
  return allowSuperset ? (actual & expected) === expected : actual === expected;
}

function normalizedExtent(size: RHITexture['descriptor']['size']): {
  width: number;
  height: number;
  depthOrArrayLayers: number;
} {
  if (typeof size === 'number') return { width: size, height: 1, depthOrArrayLayers: 1 };
  if (Array.isArray(size)) {
    return { width: size[0] ?? 1, height: size[1] ?? 1, depthOrArrayLayers: size[2] ?? 1 };
  }
  const extent = size as { width: number; height?: number; depthOrArrayLayers?: number };
  return {
    width: extent.width,
    height: extent.height ?? 1,
    depthOrArrayLayers: extent.depthOrArrayLayers ?? 1
  };
}

function bindAllVersions(
  physical: Map<GraphHandle, RHITexture | RHIBuffer>,
  resource: RenderGraphSnapshot['resources'][number],
  binding: RHITexture | RHIBuffer
): void {
  for (const version of resource.versions) physical.set(version.handle, binding);
}

function bindHistoryVersions(
  physical: Map<GraphHandle, RHITexture | RHIBuffer>,
  resource: RenderGraphSnapshot['resources'][number],
  binding: RenderGraphHistoryBinding
): void {
  for (const version of resource.versions) {
    const slot = version.version === 0 ? binding.readable : binding.writable;
    if (slot !== undefined) physical.set(version.handle, slot.handle);
  }
}

function retainedHistoryResources(plan: RenderGraphExecutionPlan) {
  const retained = collectRetainedResourceIds(plan.compiled);
  return plan.snapshot.resources.filter(
    (resource) => resource.origin.kind === 'history' && retained.has(resource.resourceId)
  );
}

function collectRetainedResourceIds(compiled: CompiledRenderGraph): ReadonlySet<number> {
  const resourceIds = new Set<number>();
  for (const pass of compiled.retainedPasses) {
    for (const access of pass.accesses) resourceIds.add(access.handle.resourceId);
    for (const terminal of pass.terminals) resourceIds.add(terminal.handle.resourceId);
  }
  return resourceIds;
}
