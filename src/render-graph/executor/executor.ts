import type {
  GraphHandle,
  GraphPassDeclaration,
  GraphTerminal,
  RenderGraphExecutionPlan,
  TransientResource
} from '../types';
import { createRenderGraphDebugIR, type RenderGraphDebugIR } from '../debug';
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
  requiredRasterGroup,
  requiredScheduledPass,
  validateRenderGraphExecutionPlan
} from './execution-plan';
import { executeRasterGroup } from './executor-raster-group';
import { freezeCommandStats } from './executor-resource-utils';
import { TransientResourcePool } from './transient-pool';
import { RestrictedContext } from '../context/restricted-context';
import { ComputePassContextImpl } from '../context/compute-context';
import { CopyPassContextImpl } from '../context/copy-context';
import type {
  RHICommandEncoder,
  RHIBuffer,
  RHICommandBuffer,
  RHICommandStats,
  RHIDevice,
  RHISubmission,
  RHITexture
} from '../../rhi/contracts';
import {
  abandonHistoryBindings,
  commitHistoryBindings,
  historyDebugStates,
  resolveResources,
  transferPreparedDrawResources,
  validatePhysicalBinding,
  validatePreparedBindGroupLayouts,
  validatePreparedComputePipelines,
  validatePreparedDrawResources,
  validatePreparedRenderPipelines,
  validateRasterGroupBindings,
  type RenderGraphExecutionInputs,
  type RenderGraphHistoryBinding,
  type SurfaceBinding
} from './executor-bindings';

export interface RenderGraphExecutionCounters {
  readonly scheduledSteps: number;
  readonly passResolutions: number;
}

/** Controls optional diagnostic capture for one graph execution. */
export interface RenderGraphExecutionOptions {
  /**
   * Captures a complete, immutable Debug IR snapshot for this execution.
   * Defaults to false so normal frames retain only bounded execution counters.
   */
  readonly captureDebug?: boolean;
}

export interface RenderGraphExecutionDebug extends RenderGraphDebugIR {
  readonly commandStats: RHICommandStats;
  readonly executionCounters: RenderGraphExecutionCounters;
}

export interface RenderGraphExecution {
  readonly commandBuffer: RHICommandBuffer;
  readonly submission: RHISubmission;
  readonly commandStats: RHICommandStats;
  readonly executionCounters: RenderGraphExecutionCounters;
  readonly debug?: RenderGraphExecutionDebug;
}

/** Execution result carrying an explicitly requested immutable Debug IR snapshot. */
export interface RenderGraphExecutionCapture extends RenderGraphExecution {
  readonly debug: RenderGraphExecutionDebug;
}

type ActivePass = EndableRenderPass;

/** Records one compiled graph into one command buffer and centrally terminates acquired surface frames. */
export class RenderGraphExecutor {
  execute(
    plan: RenderGraphExecutionPlan,
    inputs: RenderGraphExecutionInputs,
    options: Readonly<{ captureDebug: true }>
  ): RenderGraphExecutionCapture;
  execute(
    plan: RenderGraphExecutionPlan,
    inputs: RenderGraphExecutionInputs,
    options?: RenderGraphExecutionOptions
  ): RenderGraphExecution;
  execute(
    plan: RenderGraphExecutionPlan,
    inputs: RenderGraphExecutionInputs,
    options: RenderGraphExecutionOptions = {}
  ): RenderGraphExecution {
    // Canonical provenance is pure to validate and must precede acquire, allocation, or recording.
    validateRenderGraphExecutionPlan(plan);
    validatePreparedRenderPipelines(inputs);
    validatePreparedComputePipelines(inputs);
    validatePreparedBindGroupLayouts(inputs);
    validatePreparedDrawResources(inputs);
    validateRasterGroupBindings(plan, inputs);
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
        if (step.kind === 'raster-group') {
          if (encoder === undefined || resources === undefined) {
            throw new Error('Render graph pass execution requires its prelude boundary.');
          }
          const group = requiredRasterGroup(plan, step);
          passResolutions += executeRasterGroup(
            group,
            plan,
            inputs,
            resources,
            encoder,
            restrictedContexts,
            (next) => {
              activePass = next;
            }
          );
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
            inputs.preparedBindGroupLayouts ?? new Map(),
            inputs.preparedDrawResources ?? new Map(),
            encoder,
            pass.rasterDetails !== undefined
              ? {
                  renderPipelines: pass.rasterDetails.preparedRenderPipelines,
                  drawResources: pass.rasterDetails.preparedDrawResources
                }
              : pass.computeDetails !== undefined
                ? { computePipelines: pass.computeDetails.preparedComputePipelines }
                : undefined
          );
          restrictedContexts.push(context);
          try {
            if (pass.passKind === 'compute') {
              executeComputePass(pass, context, encoder, (next) => {
                activePass = next;
              });
            } else if (pass.passKind === 'copy') {
              pass.run(new CopyPassContextImpl(context));
            } else {
              throw new Error(
                `Render graph pass "${pass.id}" must be a compute or copy pass in the schedule.`
              );
            }
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
        validatePreparedDrawResources(inputs);
        submission = inputs.device.queue.submit([commandBuffer]);
        transferPreparedDrawResources(inputs, submission);
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
      const debug =
        options.captureDebug === true
          ? Object.freeze({
              ...createRenderGraphDebugIR(plan.snapshot, plan.compiled, {
                schedule: plan.schedule,
                fusion: plan.fusion,
                transitions: plan.transitions,
                historyStates: historyDebugStates(plan, inputs)
              }),
              commandStats,
              executionCounters
            })
          : undefined;
      return Object.freeze({
        commandBuffer,
        submission,
        commandStats,
        executionCounters,
        ...(debug === undefined ? {} : { debug })
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
      if (seenTokens.has(terminal.surfaceFrame.id)) {
        throw new Error(
          `Render graph surface frame token "${terminal.surfaceFrame.id}" is presented more than once.`
        );
      }
      seenTokens.add(terminal.surfaceFrame.id);
    }
    for (const terminal of terminals) {
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

function executeComputePass(
  pass: GraphPassDeclaration,
  context: RestrictedContext,
  encoder: RHICommandEncoder,
  onActivePass: (next: EndableRenderPass | undefined) => void
): void {
  const computePass = encoder.beginComputePass({ label: pass.id });
  onActivePass(computePass);
  const computeContext = new ComputePassContextImpl(context, computePass);
  try {
    pass.run(computeContext);
  } catch (error) {
    computeContext.revoke();
    onActivePass(undefined);
    try {
      computePass.end();
    } catch {
      // Preserve the original compute pass failure.
    }
    throw error;
  }
  computeContext.revoke();
  onActivePass(undefined);
  computePass.end();
}
