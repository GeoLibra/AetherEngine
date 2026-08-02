import type { GraphAccess, GraphTerminal, RenderGraphSnapshot } from './builder';
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
import {
  allocationFor,
  containsRange,
  freezeCommandStats,
  normalizeRequestedRange,
  toViewDescriptor
} from './executor-resource-utils';
import type { GraphRange, TextureGraphRange } from './ranges';
import { TransientResourcePool, type TransientResource } from './transient-pool';
import type {
  AcquiredHistorySlot,
  HistoryIdentity,
  HistoryRegistry,
  HistorySlotDebugState
} from './history';
import type {
  BufferHandle,
  BufferRange,
  BufferUsage,
  GraphHandle,
  TextureHandle,
  TextureRange,
  TextureUsage
} from './types';
import type {
  GPUColor,
  GPUComputePassDescriptor,
  GPULoadOp,
  GPUStoreOp,
  RHIBuffer,
  RHICommandBuffer,
  RHICommandStats,
  RHIComputePassEncoder,
  RHIDevice,
  RHIRenderPassEncoder,
  RHISubmission,
  RHITextureView,
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

export interface DeclaredRasterColorAttachment {
  readonly texture: TextureHandle;
  readonly range?: TextureRange;
  readonly loadOp: GPULoadOp;
  readonly storeOp: GPUStoreOp;
  readonly clearValue?: GPUColor;
}

export interface DeclaredRasterDepthStencilAttachment {
  readonly texture: TextureHandle;
  readonly range?: TextureRange;
  readonly depthLoadOp?: GPULoadOp;
  readonly depthStoreOp?: GPUStoreOp;
  readonly depthClearValue?: number;
  readonly stencilLoadOp?: GPULoadOp;
  readonly stencilStoreOp?: GPUStoreOp;
  readonly stencilClearValue?: number;
}

export interface DeclaredRasterPass {
  readonly label?: string;
  readonly colorAttachments: readonly DeclaredRasterColorAttachment[];
  readonly depthStencilAttachment?: DeclaredRasterDepthStencilAttachment;
}

/** The only GPU capability visible to a user render-pass callback. */
export interface RestrictedPassContext {
  texture(handle: TextureHandle, usage: TextureUsage, range?: TextureRange): RestrictedTextureView;
  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RestrictedBufferSlice;
  beginRaster(descriptor: DeclaredRasterPass): RHIRenderPassEncoder;
  beginCompute(descriptor?: GPUComputePassDescriptor): RHIComputePassEncoder;
}

/** Native texture objects stay private; this immutable capability is restricted to one declared range. */
export interface RestrictedTextureView {
  readonly kind: 'restricted-texture-view';
  readonly range: TextureGraphRange;
}

/** Opaque range capability; callbacks cannot map, dispose, or escape to the whole RHI buffer. */
export interface RestrictedBufferSlice {
  readonly kind: 'restricted-buffer-slice';
  readonly offset: number;
  readonly size: number;
}

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
    const frames: SurfaceBinding[] = [];
    const transientResources: TransientResource[] = [];
    const ownsPool = inputs.transientPool === undefined;
    const pool = inputs.transientPool ?? new TransientResourcePool(inputs.device);
    let encoder: ReturnType<RHIDevice['createCommandEncoder']> | undefined;
    let activePass: ActivePass | undefined;
    let commandBuffer: RHICommandBuffer | undefined;
    let submission: RHISubmission | undefined;
    let finished = false;
    let resources: ReadonlyMap<number, RHITexture | RHIBuffer> | undefined;
    let scheduledSteps = 0;
    let passResolutions = 0;

    try {
      this.acquireSurfaceFrames(plan, inputs, frames);
      validateRenderGraphExecutionPlan(plan);
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
            encoder,
            (next) => {
              activePass = next;
            },
            () => {
              activePass = undefined;
            }
          );
          pass.run(context.publicContext());
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

class RestrictedContext implements RestrictedPassContext {
  private activePass: ActivePass | undefined;

  constructor(
    private readonly accesses: readonly GraphAccess[],
    private readonly resources: ReadonlyMap<number, RHITexture | RHIBuffer>,
    private readonly encoder: ReturnType<RHIDevice['createCommandEncoder']>,
    private readonly onBegin: (pass: ActivePass) => void,
    private readonly onEnd: () => void
  ) {}

  /** Returns a capability facade so callbacks cannot reach recording internals at runtime. */
  publicContext(): RestrictedPassContext {
    return Object.freeze({
      texture: this.texture.bind(this),
      buffer: this.buffer.bind(this),
      beginRaster: this.beginRaster.bind(this),
      beginCompute: this.beginCompute.bind(this)
    });
  }

  texture(handle: TextureHandle, usage: TextureUsage, range?: TextureRange): RestrictedTextureView {
    this.requireInactive('resolve a texture');
    const resolved = this.requiredTexture(handle, usage, range);
    return Object.freeze({ kind: 'restricted-texture-view', range: resolved.range });
  }

  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RestrictedBufferSlice {
    this.requireInactive('resolve a buffer');
    const resolved = this.requiredResource(handle, usage, range);
    if (resolved.resource.kind !== 'buffer')
      throw new Error('Render graph buffer handle resolved to a texture.');
    if (resolved.range.kind !== 'buffer') throw new Error('Render graph buffer range is invalid.');
    return Object.freeze({
      kind: 'restricted-buffer-slice',
      offset: resolved.range.offset,
      size: resolved.range.size
    });
  }

  beginRaster(descriptor: DeclaredRasterPass): RHIRenderPassEncoder {
    this.requireInactive('begin a raster pass');
    const colorAttachments = descriptor.colorAttachments.map((attachment) => {
      const view = this.textureView(attachment.texture, 'color-attachment', attachment.range);
      return {
        view,
        loadOp: attachment.loadOp,
        storeOp: attachment.storeOp,
        ...(attachment.clearValue === undefined ? {} : { clearValue: attachment.clearValue })
      };
    });
    const depth = descriptor.depthStencilAttachment;
    const depthStencilAttachment =
      depth === undefined
        ? undefined
        : {
            view: this.textureView(depth.texture, 'depth-stencil-attachment', depth.range),
            ...(depth.depthLoadOp === undefined ? {} : { depthLoadOp: depth.depthLoadOp }),
            ...(depth.depthStoreOp === undefined ? {} : { depthStoreOp: depth.depthStoreOp }),
            ...(depth.depthClearValue === undefined
              ? {}
              : { depthClearValue: depth.depthClearValue }),
            ...(depth.stencilLoadOp === undefined ? {} : { stencilLoadOp: depth.stencilLoadOp }),
            ...(depth.stencilStoreOp === undefined ? {} : { stencilStoreOp: depth.stencilStoreOp }),
            ...(depth.stencilClearValue === undefined
              ? {}
              : { stencilClearValue: depth.stencilClearValue })
          };
    const encoder = this.encoder.beginRenderPass({
      ...(descriptor.label === undefined ? {} : { label: descriptor.label }),
      colorAttachments,
      ...(depthStencilAttachment === undefined ? {} : { depthStencilAttachment })
    });
    return this.track(encoder);
  }

  beginCompute(descriptor: GPUComputePassDescriptor = {}): RHIComputePassEncoder {
    this.requireInactive('begin a compute pass');
    return this.track(this.encoder.beginComputePass(descriptor));
  }

  private track<T extends ActivePass>(pass: T): T {
    const end = pass.end.bind(pass);
    let ended = false;
    const tracked = new Proxy(pass, {
      get: (target, property) => {
        if (property === 'end') {
          return () => {
            if (ended) throw new Error('Render graph pass encoder has already ended.');
            ended = true;
            end();
            this.activePass = undefined;
            this.onEnd();
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    this.activePass = tracked;
    this.onBegin(tracked);
    return tracked;
  }

  private requiredTexture(
    handle: TextureHandle,
    usage: TextureUsage,
    requestedRange: TextureRange | undefined
  ): { readonly resource: RHITexture; readonly range: TextureGraphRange } {
    const resolved = this.requiredResource(handle, usage, requestedRange);
    if (resolved.resource.kind !== 'texture') {
      throw new Error('Render graph texture handle resolved to a buffer.');
    }
    if (resolved.range.kind !== 'texture')
      throw new Error('Render graph texture range is invalid.');
    return { resource: resolved.resource, range: resolved.range };
  }

  private textureView(
    handle: TextureHandle,
    usage: TextureUsage,
    requestedRange: TextureRange | undefined
  ): RHITextureView {
    const resolved = this.requiredTexture(handle, usage, requestedRange);
    return resolved.resource.createView(toViewDescriptor(resolved.range));
  }

  private requiredResource(
    handle: GraphHandle,
    usage: TextureUsage | BufferUsage,
    requestedRange: TextureRange | BufferRange | undefined
  ): { readonly resource: RHITexture | RHIBuffer; readonly range: GraphRange } {
    const access = this.accesses.find(
      (candidate) => candidate.handle === handle && candidate.usage === usage
    );
    if (access === undefined) {
      const declared = this.accesses.some((candidate) => candidate.handle === handle);
      throw new Error(
        declared
          ? `Render graph resource usage "${usage}" is not declared for this pass.`
          : 'Render graph resource is not declared for this pass.'
      );
    }
    const range = normalizeRequestedRange(handle, requestedRange, access.range);
    if (!containsRange(access.range, range)) {
      throw new Error('Render graph resource range is outside this pass declaration.');
    }
    const resource = this.resources.get(handle.resourceId);
    if (resource === undefined)
      throw new Error(`Render graph resource ${handle.resourceId} has no physical binding.`);
    return { resource, range };
  }

  private requireInactive(action: string): void {
    if (this.activePass !== undefined)
      throw new Error(`Cannot ${action} while a render graph pass encoder is active.`);
  }
}

function resolveResources(
  plan: RenderGraphExecutionPlan,
  inputs: RenderGraphExecutionInputs,
  frames: readonly SurfaceBinding[],
  pool: TransientResourcePool,
  transients: TransientResource[]
): ReadonlyMap<number, RHITexture | RHIBuffer> {
  const { snapshot, compiled } = plan;
  const physical = new Map<number, RHITexture | RHIBuffer>();
  const physicalAliases = new Map<number, TransientResource>();
  const frameResources = new Map(
    frames.map((binding) => [binding.resourceId, binding.frame.texture])
  );
  const retainedResourceIds = collectRetainedResourceIds(compiled);
  for (const resource of snapshot.resources) {
    if (!retainedResourceIds.has(resource.resourceId)) continue;
    const frame = frameResources.get(resource.resourceId);
    if (frame !== undefined) {
      physical.set(resource.resourceId, frame);
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
      physical.set(resource.resourceId, transient);
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
      physical.set(resource.resourceId, binding.handle);
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
    physical.set(resource.resourceId, imported);
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
  if (binding.handle.generation !== device.generation) {
    throw new Error(
      'Render graph history physical resource belongs to a different device generation.'
    );
  }
  binding.registry.assertAcquiredBinding(binding.identity, binding);
  if (binding.valid !== resource.historyValid) {
    throw new Error('Render graph history validity does not match the acquired registry slot.');
  }
  if (!descriptorsEqual(allocationFor(resource), binding.identity.descriptor)) {
    throw new Error(
      'Render graph history binding descriptor is incompatible with the graph resource.'
    );
  }
  if (binding.handle.kind !== resource.kind || binding.handle.state !== 'live') {
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
    if (written) binding.registry.publish(binding.identity, binding.slot, submission);
    else binding.registry.retain(binding.identity, binding.slot, submission);
  }
}

function historyDebugStates(
  plan: RenderGraphExecutionPlan,
  inputs: RenderGraphExecutionInputs
): ReadonlyMap<number, HistorySlotDebugState> {
  const states = new Map<number, HistorySlotDebugState>();
  for (const resource of retainedHistoryResources(plan)) {
    const binding = inputs.histories?.get(resource.versions[0]?.handle as GraphHandle);
    const state = binding?.registry
      .debugState(binding.identity)
      .find((candidate) => candidate.slot === binding.slot);
    if (state !== undefined) states.set(resource.resourceId, state);
  }
  return states;
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
