import type { GraphTerminal, RenderGraphSnapshot } from './builder';
import type { CompiledRenderGraph } from './compiler';
import { createRenderGraphDebugIR, type RenderGraphDebugIR } from './debug-ir';
import {
  releaseTransients,
  safelyDispose,
  safelyEnd,
  safelyFinish,
  safelyReleaseFrame,
  safelyReleaseTransients,
  type EndableRenderPass
} from './executor-cleanup';
import {
  requiredScheduledPass,
  validateRenderGraphExecutionPlan,
  type RenderGraphExecutionPlan
} from './execution-plan';
import { allocationFor, freezeCommandStats } from './executor-resource-utils';
import { TransientResourcePool, type TransientResource } from './transient-pool';
import { RestrictedContext } from './restricted-context';
import type {
  PreparedComputePipelineBindings,
  PreparedRenderPipelineBindings
} from './prepared-resources';
export type {
  DeclaredRasterColorAttachment,
  DeclaredRasterDepthStencilAttachment,
  DeclaredRasterPass,
  RestrictedBindGroupDescriptor,
  RestrictedBindGroupEntry,
  RestrictedBindGroup,
  RestrictedBindGroupLayout,
  RestrictedBufferSlice,
  RestrictedComputePipeline,
  RestrictedComputePipelineDescriptor,
  RestrictedComputePassEncoder,
  RestrictedPassContext,
  RestrictedPipelineLayout,
  RestrictedPipelineLayoutDescriptor,
  RestrictedPortableDevice,
  RestrictedRenderPipeline,
  RestrictedRenderPipelineDescriptor,
  RestrictedRenderPassEncoder,
  RestrictedSampler,
  RestrictedShaderModule,
  RestrictedTextureView
} from './types';
import type { AcquiredHistorySlot, HistoryIdentity, HistoryRegistry } from './history';
import type { GraphHandle } from './types';
import type { RenderGraphHistoryDebugBinding } from './debug-ir';
import type {
  RHIBuffer,
  RHICommandBuffer,
  RHICommandStats,
  RHIDevice,
  RHISubmission,
  RHITexture
} from '../rhi/contracts';
import type { RHISurface, RHISurfaceFrame } from '../rhi/contracts/surface';

export {
  assertRenderGraphExecutionPlan,
  createRenderGraphExecutionPlan,
  createRenderGraphExecutionSchedule,
  requiredScheduledPass,
  validateRenderGraphExecutionPlan
} from './execution-plan';
export type { RenderGraphExecutionPlan, RenderGraphExecutionStep } from './execution-plan';

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
}

export interface RenderGraphExecutionDebug extends RenderGraphDebugIR {
  readonly commandStats: RHICommandStats;
  readonly executionCounters: RenderGraphExecutionCounters;
}

export interface RenderGraphExecutionCounters {
  readonly scheduledSteps: number;
  readonly passResolutions: number;
}

export interface RenderGraphExecution {
  readonly commandBuffer: RHICommandBuffer;
  readonly submission: RHISubmission;
  readonly commandStats: RHICommandStats;
  readonly executionCounters: RenderGraphExecutionCounters;
  readonly debug: RenderGraphExecutionDebug;
  readonly debugIR: RenderGraphExecutionDebug;
}

type ActivePass = EndableRenderPass;
interface SurfaceBinding {
  readonly frame: RHISurfaceFrame;
  readonly resourceId: number;
}

/** Records one compiled graph into one command buffer and centrally terminates acquired surface frames. */
export class RenderGraphExecutor {
  execute(
    plan: RenderGraphExecutionPlan,
    inputs: RenderGraphExecutionInputs
  ): RenderGraphExecution {
    // Canonical provenance is pure to validate and must precede acquire, allocation, or recording.
    validateRenderGraphExecutionPlan(plan);
    validatePreparedRenderPipelines(inputs);
    validatePreparedComputePipelines(inputs);
    const frames: SurfaceBinding[] = [];
    const transientResources: TransientResource[] = [];
    const restrictedContexts: RestrictedContext[] = [];
    const ownsPool = inputs.transientPool === undefined;
    const pool = inputs.transientPool ?? new TransientResourcePool(inputs.device);
    let encoder: ReturnType<RHIDevice['createCommandEncoder']> | undefined;
    let activePass: ActivePass | undefined;
    let commandBuffer: RHICommandBuffer | undefined;
    let submission: RHISubmission | undefined;
    let finished = false;
    let resources: ReadonlyMap<GraphHandle, RHITexture | RHIBuffer> | undefined;
    let scheduledSteps = 0;
    let passResolutions = 0;

    try {
      this.acquireSurfaceFrames(plan, inputs, frames);
      for (let scheduleIndex = 0; scheduleIndex < plan.schedule.length; scheduleIndex += 1) {
        const step = plan.schedule[scheduleIndex]!;
        scheduledSteps++;
        if (step.kind === 'prelude') {
          resources = resolveResources(plan, inputs, frames, pool, transientResources);
          encoder = inputs.device.createCommandEncoder({ label: 'render-graph' });
          continue;
        }
        if (step.kind === 'pass') {
          if (encoder === undefined || resources === undefined) {
            throw new Error('Render graph pass execution requires its prelude boundary.');
          }
          const pass = requiredScheduledPass(plan.compiled, step);
          passResolutions++;
          const context = new RestrictedContext(
            pass.accesses,
            resources,
            new Map(plan.snapshot.resources.map((resource) => [resource.resourceId, resource])),
            inputs.device,
            inputs.preparedRenderPipelines ?? new Map(),
            inputs.preparedComputePipelines ?? new Map(),
            encoder,
            (next) => {
              activePass = next;
            },
            () => {
              activePass = undefined;
            }
          );
          restrictedContexts.push(context);
          try {
            pass.run(context.publicContext());
          } finally {
            context.close();
          }
          if (activePass !== undefined) {
            throw new Error(
              `Render graph pass "${pass.id}" must end the active pass encoder before it returns.`
            );
          }
          continue;
        }
        if (encoder === undefined) {
          throw new Error('Render graph submission requires its prelude boundary.');
        }
        commandBuffer = encoder.finish({ label: 'render-graph' });
        finished = true;
        submission = inputs.device.queue.submit([commandBuffer]);
        for (const context of restrictedContexts) context.retireResources(submission);
        releaseTransients(pool, transientResources, submission);
        commitHistoryBindings(plan, inputs, submission);
        if (ownsPool) pool.dispose();
        this.presentFrames(frames);
      }
      if (commandBuffer === undefined || submission === undefined) {
        throw new Error('Render graph execution plan is missing its submission boundary.');
      }
      const commandStats = freezeCommandStats(commandBuffer.getStats());
      const executionCounters = Object.freeze({ scheduledSteps, passResolutions });
      const debug = Object.freeze({
        ...createRenderGraphDebugIR(plan.snapshot, plan.compiled, {
          schedule: plan.schedule,
          historyStates: historyDebugStates(plan, inputs)
        }),
        commandStats,
        executionCounters
      });
      return Object.freeze({
        commandBuffer,
        submission,
        commandStats,
        executionCounters,
        debug,
        debugIR: debug
      });
    } catch (error) {
      // The caller's failure is primary; best-effort shutdown must not mask it.
      safelyEnd(activePass);
      if (encoder !== undefined && !finished) safelyFinish(encoder);
      if (submission === undefined) safelyReleaseTransients(pool, transientResources);
      if (submission === undefined) {
        for (const context of restrictedContexts) context.disposeResources();
      }
      if (submission === undefined) abandonHistoryBindings(plan, inputs);
      if (ownsPool) safelyDispose(pool);
      throw error;
    } finally {
      for (const binding of frames) safelyReleaseFrame(binding.frame);
    }
  }

  private acquireSurfaceFrames(
    plan: RenderGraphExecutionPlan,
    inputs: RenderGraphExecutionInputs,
    frames: SurfaceBinding[]
  ): void {
    const terminals = plan.snapshot.terminals.filter(
      (terminal): terminal is Extract<GraphTerminal, { kind: 'present' }> =>
        terminal.kind === 'present'
    );
    const seenTokens = new Set<string>();
    for (const terminal of terminals) {
      if (!seenTokens.add(terminal.surfaceFrame.id)) {
        throw new Error(
          `Render graph surface frame token "${terminal.surfaceFrame.id}" is presented more than once.`
        );
      }
      const surface = inputs.surfaces?.get(terminal.surfaceFrame.id) ?? inputs.surface;
      if (surface === undefined) {
        throw new Error(
          `Render graph present terminal requires surface frame "${terminal.surfaceFrame.id}".`
        );
      }
      const acquired = surface.acquire();
      if (acquired.status !== 'success') {
        throw new Error(`Render graph surface acquisition failed: ${acquired.status}.`);
      }
      const resource = plan.snapshot.resources[terminal.handle.resourceId];
      if (
        resource?.kind !== 'texture' ||
        resource.origin.kind !== 'imported' ||
        resource.origin.acquire.id !== terminal.surfaceFrame.id
      ) {
        throw new Error(
          'Render graph present terminal does not match an imported surface acquire.'
        );
      }
      frames.push({ frame: acquired.frame, resourceId: terminal.handle.resourceId });
      validatePhysicalBinding(resource, acquired.frame.texture, inputs.device);
    }
  }

  private presentFrames(frames: readonly SurfaceBinding[]): void {
    for (const binding of frames) binding.frame.present();
  }
}

function validatePreparedRenderPipelines(inputs: RenderGraphExecutionInputs): void {
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

function validatePreparedComputePipelines(inputs: RenderGraphExecutionInputs): void {
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

function resolveResources(
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

function validatePhysicalBinding(
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
  if (!descriptorsEqual(allocationFor(resource), actual)) {
    throw new Error(
      'Render graph physical binding descriptor is incompatible with the graph resource.'
    );
  }
}

function descriptorsEqual(
  expected: ReturnType<typeof allocationFor>,
  actual: ReturnType<typeof allocationFor>
): boolean {
  if (expected.kind !== actual.kind) return false;
  if (expected.kind === 'buffer' && actual.kind === 'buffer') {
    return (
      expected.descriptor.size === actual.descriptor.size &&
      expected.descriptor.usage === actual.descriptor.usage
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
      expected.descriptor.usage === actual.descriptor.usage &&
      (expected.descriptor.mipLevelCount ?? 1) === (actual.descriptor.mipLevelCount ?? 1) &&
      (expected.descriptor.sampleCount ?? 1) === (actual.descriptor.sampleCount ?? 1)
    );
  }
  return false;
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

function commitHistoryBindings(
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

function historyDebugStates(
  plan: RenderGraphExecutionPlan,
  inputs: RenderGraphExecutionInputs
): ReadonlyMap<number, RenderGraphHistoryDebugBinding> {
  // This map exists only while createRenderGraphDebugIR validates and snapshots it. That
  // public boundary clones and freezes every binding, so these intermediary records do
  // not need a second integrity transition.
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

function abandonHistoryBindings(
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
