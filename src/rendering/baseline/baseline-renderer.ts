import {
  RenderGraphBuilder,
  RenderGraphExecutor,
  RenderSystemRegistry,
  compileRenderSystems
} from '../../render-graph';
import { ZERO_RESOURCE_BUDGET } from '../../feature-policy';
import type { TextureDescriptor } from '../../render-graph';
import { buildPreparedDrawPhase, createOpaqueRenderSystem } from '../phase';
import {
  createWebGlFragmentLightListImplementation,
  createWebGpuComputeLightListImplementation
} from '../lighting';
import { BASELINE_LIGHT_LIST_CAPACITY } from './baseline-preparation';
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
    const graph = new RenderGraphBuilder();
    const lightList =
      prepared.lightList === undefined ? undefined : contributeLightList(graph, prepared);
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
      ),
      ...(lightList === undefined || prepared.lightList === undefined
        ? {}
        : {
            lightList: {
              source: lightList.output.source,
              packedLights: lightList.lights as never,
              output: lightList.output as never,
              bindGroupLayout: prepared.lightList.forwardBindGroupLayoutToken
            } as NonNullable<Parameters<typeof createOpaqueRenderSystem>[0]['lightList']>
          })
    });
    const systems = new RenderSystemRegistry();
    systems.add(opaque.descriptor);
    const compiled = compileRenderSystems(systems, { views: [prepared.view], graph });
    let execution: ReturnType<RenderGraphExecutor['execute']>;
    try {
      const lightFrame = prepared.lightList;
      execution = new RenderGraphExecutor().execute(compiled.plan, {
        device,
        surface,
        preparedDrawResources: opaque.preparedDrawResources,
        ...(lightList === undefined || lightFrame === undefined
          ? {}
          : {
              resources: new Map([
                [lightList.lights, lightFrame.lights],
                [lightList.receivers, lightFrame.receivers]
              ]),
              ...(lightFrame.source === 'webgl-fragment'
                ? {
                    preparedRenderPipelines: new Map([
                      [lightFrame.recorder.pipelineToken, lightFrame.recorder.pipeline]
                    ])
                  }
                : {
                    preparedComputePipelines: new Map([
                      [lightFrame.recorder.pipelineToken, lightFrame.recorder.pipeline]
                    ])
                  }),
              preparedBindGroupLayouts: new Map([
                [lightFrame.recorder.bindGroupLayoutToken, lightFrame.recorder.bindGroupLayout],
                [lightFrame.forwardBindGroupLayoutToken, lightFrame.forwardBindGroupLayout]
              ])
            })
      });
      lightFrame?.retain(execution.submission);
    } catch (error) {
      for (const packet of phase.snapshot.packets) packet.release();
      prepared.lightList?.release();
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

function contributeLightList(
  graph: RenderGraphBuilder,
  prepared: Extract<BaselinePreparedFrame, { status: 'ready' }>
) {
  if (prepared.lightList === undefined) throw new Error('Baseline LightList input is missing.');
  const origin = {
    kind: 'imported' as const,
    initialState:
      prepared.lightList.source === 'gpu-compute'
        ? ('storage-read' as const)
        : ('sampled' as const),
    acquire: { kind: 'external-acquire' as const, id: `${prepared.view.id}:light-list-input` }
  };
  if (prepared.lightList.source === 'gpu-compute') {
    const lights = graph.createBuffer(
      { size: prepared.lightList.lights.size, usage: ['storage-read', 'uniform'] },
      { origin }
    );
    const receivers = graph.createBuffer(
      { size: prepared.lightList.receivers.size, usage: ['storage-read'] },
      {
        origin: { ...origin, acquire: { ...origin.acquire, id: `${origin.acquire.id}:receivers` } }
      }
    );
    let output: import('../lighting').WebGpuLightListBuildOutput | undefined;
    createWebGpuComputeLightListImplementation({
      capacity: BASELINE_LIGHT_LIST_CAPACITY,
      estimatedBudget: ZERO_RESOURCE_BUDGET
    }).contribute(BASELINE_LIGHT_LIST_CAPACITY, {
      graph,
      viewId: prepared.view.id,
      input: { lights, receivers, receiverCount: prepared.lightList.receiverCount },
      recorder: prepared.lightList.recorder.recorder,
      publish(value) {
        output = value;
      }
    });
    if (output === undefined) throw new Error('WebGPU LightList did not publish output.');
    return { lights, receivers, output };
  }
  const texture = (raw: typeof prepared.lightList.lights, id: string) =>
    graph.createTexture(
      {
        width: raw.width,
        height: raw.height,
        depthOrArrayLayers: raw.depthOrArrayLayers,
        mipLevelCount: 1,
        sampleCount: 1,
        format: raw.format,
        usage: ['sampled']
      },
      { origin: { ...origin, acquire: { ...origin.acquire, id } } }
    );
  const lights = texture(prepared.lightList.lights, `${origin.acquire.id}:lights`);
  const receivers = texture(prepared.lightList.receivers, `${origin.acquire.id}:receivers`);
  let output: import('../lighting').WebGlFragmentLightListBuildOutput | undefined;
  createWebGlFragmentLightListImplementation({
    capacity: BASELINE_LIGHT_LIST_CAPACITY,
    estimatedBudget: ZERO_RESOURCE_BUDGET,
    maxTextureDimension2D: prepared.lightList.maxTextureDimension2D
  }).contribute(BASELINE_LIGHT_LIST_CAPACITY, {
    graph,
    viewId: prepared.view.id,
    input: { lights, receivers, receiverCount: prepared.lightList.receiverCount },
    recorder: prepared.lightList.recorder.recorder,
    publish(value) {
      output = value;
    }
  });
  if (output === undefined) throw new Error('WebGL2 LightList did not publish output.');
  return { lights, receivers, output };
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
