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
  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RHIBuffer;
  beginRaster(descriptor: DeclaredRasterPass): RHIRenderPassEncoder;
  beginCompute(descriptor?: GPUComputePassDescriptor): RHIComputePassEncoder;
}

/** Native texture objects stay private; this immutable capability is restricted to one declared range. */
export interface RestrictedTextureView {
  readonly kind: 'restricted-texture-view';
  readonly range: TextureGraphRange;
}

export interface RenderGraphExecutionInputs {
  readonly device: RHIDevice;
  /** Physical resources for imported and history graph resources, keyed by their version-zero handle. */
  readonly resources?: ReadonlyMap<GraphHandle, RHITexture | RHIBuffer>;
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
          resources = resolveResources(
            plan.snapshot,
            plan.compiled,
            inputs,
            frames,
            pool,
            transientResources
          );
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
        if (ownsPool) pool.dispose();
        this.presentFrames(frames);
      }
      if (commandBuffer === undefined || submission === undefined) {
        throw new Error('Render graph execution plan is missing its submission boundary.');
      }
      const commandStats = freezeCommandStats(commandBuffer.getStats());
      const executionCounters = Object.freeze({ scheduledSteps, passResolutions });
      const debug = Object.freeze({
        ...createRenderGraphDebugIR(plan.snapshot, plan.compiled, { schedule: plan.schedule }),
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
      frames.push({ frame: acquired.frame, resourceId: terminal.handle.resourceId });
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

  buffer(handle: BufferHandle, usage: BufferUsage, range?: BufferRange): RHIBuffer {
    this.requireInactive('resolve a buffer');
    const resolved = this.requiredResource(handle, usage, range);
    if (resolved.resource.kind !== 'buffer')
      throw new Error('Render graph buffer handle resolved to a texture.');
    return resolved.resource;
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
  snapshot: RenderGraphSnapshot,
  compiled: CompiledRenderGraph,
  inputs: RenderGraphExecutionInputs,
  frames: readonly SurfaceBinding[],
  pool: TransientResourcePool,
  transients: TransientResource[]
): ReadonlyMap<number, RHITexture | RHIBuffer> {
  const physical = new Map<number, RHITexture | RHIBuffer>();
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
      const transient = pool.acquire(allocationFor(resource));
      transients.push(transient);
      physical.set(resource.resourceId, transient);
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
    physical.set(resource.resourceId, imported);
  }
  return physical;
}

function collectRetainedResourceIds(compiled: CompiledRenderGraph): ReadonlySet<number> {
  const resourceIds = new Set<number>();
  for (const pass of compiled.retainedPasses) {
    for (const access of pass.accesses) resourceIds.add(access.handle.resourceId);
    for (const terminal of pass.terminals) resourceIds.add(terminal.handle.resourceId);
  }
  return resourceIds;
}
