import type { GraphTerminal } from '../builder/builder';
import { createRenderGraphDebugIR, type RenderGraphDebugIR } from '../compiler/debug-ir';
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
import { freezeCommandStats } from './executor-resource-utils';
import { TransientResourcePool, type TransientResource } from './transient-pool';
import { RestrictedContext } from '../context/restricted-context';
import type {
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
  type RenderGraphExecutionInputs,
  type RenderGraphHistoryBinding,
  type SurfaceBinding
} from './executor-bindings';

export type { RenderGraphExecutionInputs, RenderGraphHistoryBinding } from './executor-bindings';

export {
  assertRenderGraphExecutionPlan,
  createRenderGraphExecutionPlan,
  createRenderGraphExecutionSchedule,
  requiredScheduledPass,
  validateRenderGraphExecutionPlan
} from './execution-plan';
export type { RenderGraphExecutionPlan, RenderGraphExecutionStep } from '../types';

export interface RenderGraphExecutionCounters {
  readonly scheduledSteps: number;
  readonly passResolutions: number;
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
  readonly debug: RenderGraphExecutionDebug;
  readonly debugIR: RenderGraphExecutionDebug;
}

type ActivePass = EndableRenderPass;

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
    validatePreparedBindGroupLayouts(inputs);
    validatePreparedDrawResources(inputs);
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
    let resources: ReadonlyMap<import('../types').GraphHandle, RHITexture | RHIBuffer> | undefined;
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
            inputs.preparedBindGroupLayouts ?? new Map(),
            inputs.preparedDrawResources ?? new Map(),
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
