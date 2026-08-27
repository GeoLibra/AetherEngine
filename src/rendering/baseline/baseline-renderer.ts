import {
  RenderGraphExecutor,
  RenderSystemRegistry,
  compileRenderSystems
} from '../../render-graph';
import type { TextureDescriptor } from '../../render-graph';
import { buildPreparedDrawPhase, createOpaqueRenderSystem } from '../phase';
import type {
  BaselinePreparedFrame,
  BaselineRenderDiagnostics,
  BaselineRenderSkipReason,
  BaselineRenderingOptions
} from './types';

/** Executes immutable ready snapshots without compiling or creating draw resources in the frame loop. */
export class BaselineRenderer {
  private frameIndex = 0;
  private disposed = false;

  get isDisposed(): boolean {
    return this.disposed;
  }

  constructor(private readonly options: BaselineRenderingOptions) {
    if (options.graphics.surface.target === undefined) {
      throw new Error('BaselineRenderer requires one graphics surface target.');
    }
  }

  /** Consumes one preparation snapshot and submits at most one opaque graph. */
  frame(prepared: BaselinePreparedFrame): BaselineRenderDiagnostics {
    if (this.disposed) throw new Error('Cannot render with a disposed BaselineRenderer.');
    const frame = ++this.frameIndex;
    const { device, surface } = this.options.graphics;
    if (prepared.deviceGeneration !== device.generation) {
      return skipped(frame, prepared, 'stale-device-generation');
    }
    if (prepared.surfaceGeneration !== surface.generation) {
      return skipped(frame, prepared, 'stale-surface-generation');
    }
    const configuration = surface.configuration;
    if (
      surface.state !== 'configured' ||
      configuration === undefined ||
      configuration.width === 0 ||
      configuration.height === 0
    ) {
      return skipped(frame, prepared, 'surface-suspended');
    }
    if (prepared.status !== 'ready') {
      return skipped(
        frame,
        prepared,
        prepared.status === 'pending' ? 'prepare-pending' : 'missing-resource'
      );
    }

    const phase = buildPreparedDrawPhase(prepared.view.id, 'opaque', prepared.packets);
    const opaque = createOpaqueRenderSystem({
      phase: phase.snapshot,
      surfaceFrame: { kind: 'surface-frame', id: prepared.view.surface },
      color: attachment(
        configuration.width,
        configuration.height,
        configuration.format,
        'color-attachment'
      ),
      depth: attachment(
        configuration.width,
        configuration.height,
        'depth24plus',
        'depth-stencil-attachment'
      )
    });
    const systems = new RenderSystemRegistry();
    systems.add(opaque.descriptor);
    const compiled = compileRenderSystems(systems, { views: [prepared.view] });
    let execution: ReturnType<RenderGraphExecutor['execute']>;
    try {
      execution = new RenderGraphExecutor().execute(compiled.plan, {
        device,
        surface,
        preparedDrawResources: opaque.preparedDrawResources
      });
    } catch (error) {
      for (const packet of phase.snapshot.packets) packet.release();
      throw error;
    }
    return Object.freeze({
      frame,
      viewId: prepared.view.id,
      status: 'rendered',
      indexedDrawCalls: execution.commandStats.draw.indexedDrawCalls,
      indexCount: execution.commandStats.draw.indexCount,
      submissionId: execution.submission.id,
      deviceGeneration: device.generation,
      surfaceGeneration: surface.generation
    });
  }

  dispose(): void {
    this.disposed = true;
  }
}

function skipped(
  frame: number,
  prepared: BaselinePreparedFrame,
  reason: BaselineRenderSkipReason
): BaselineRenderDiagnostics {
  return Object.freeze({
    frame,
    viewId: prepared.view.id,
    status: 'skipped',
    reason,
    deviceGeneration: prepared.deviceGeneration,
    surfaceGeneration: prepared.surfaceGeneration
  });
}

function attachment(
  width: number,
  height: number,
  format: TextureDescriptor['format'],
  usage: 'color-attachment' | 'depth-stencil-attachment'
): TextureDescriptor {
  return Object.freeze({
    width,
    height,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format,
    usage: Object.freeze([usage])
  });
}
