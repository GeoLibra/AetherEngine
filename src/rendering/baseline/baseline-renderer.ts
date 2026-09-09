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
  createWebGpuComputeLightListImplementation,
  type WebGlFragmentLightListBuildOutput,
  type WebGpuLightListBuildOutput
} from '../lighting';
import { BASELINE_LIGHT_LIST_CAPACITY } from './baseline-preparation';
import type {
  BaselinePreparedFrame,
  BaselineRenderDiagnostics,
  BaselineRenderSkipReason,
  BaselineRenderingOptions
} from './types';
import type { RHITexture } from '../../rhi/contracts';
import { contributeBackground, createBackgroundRenderSystem } from '../background/graph';
import { createPostColorContribution } from './baseline-post-color-graph';

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
    const post =
      prepared.postColor === undefined
        ? undefined
        : createPostColorContribution(graph, prepared, configuration);
    const environment =
      prepared.environment === undefined ? undefined : contributeEnvironment(graph, prepared);
    const lightList =
      prepared.lightList === undefined ? undefined : contributeLightList(graph, prepared);
    const bgFrame = prepared.background;
    const bgContribution =
      bgFrame !== undefined && bgFrame.status === 'ready'
        ? contributeBackground(graph, bgFrame, prepared.view.id)
        : undefined;
    const colorTarget =
      post?.hdrTarget ??
      graph.createTexture(
        attachment(
          configuration.width,
          configuration.height,
          post === undefined ? configuration.format : 'rgba16float',
          'color-attachment'
        ),
        post === undefined
          ? {
              origin: {
                kind: 'imported',
                initialState: 'undefined',
                acquire: { kind: 'external-acquire', id: prepared.view.surface }
              }
            }
          : undefined
      );
    const depthTarget = graph.createTexture(
      attachment(
        configuration.width,
        configuration.height,
        'depth24plus',
        'depth-stencil-attachment'
      )
    );

    let activeColorTarget = colorTarget;
    let activeDepthTarget = depthTarget;
    const bgSystem =
      bgContribution !== undefined && bgFrame !== undefined && bgFrame.status === 'ready'
        ? createBackgroundRenderSystem({
            viewId: prepared.view.id,
            prepared: bgFrame,
            colorTarget,
            depthTarget,
            publishColor(color) {
              activeColorTarget = color;
            },
            publishDepth(depth) {
              activeDepthTarget = depth;
            },
            uniformBuffer: bgContribution.uniformBuffer,
            skyTexture: bgContribution.skyTexture,
            width: configuration.width,
            height: configuration.height
          })
        : undefined;

    const opaque = createOpaqueRenderSystem({
      phase: phase.snapshot,
      surfaceFrame: { kind: 'surface-frame', id: prepared.view.surface },
      color: attachment(
        configuration.width,
        configuration.height,
        post === undefined ? configuration.format : 'rgba16float',
        'color-attachment'
      ),
      depth: attachment(
        configuration.width,
        configuration.height,
        'depth24plus',
        'depth-stencil-attachment'
      ),
      colorLoadOp: bgSystem !== undefined ? 'load' : 'clear',
      depthLoadOp: bgSystem !== undefined ? 'load' : 'clear',
      colorTarget: () => activeColorTarget,
      depthTarget: () => activeDepthTarget,
      present: post === undefined,
      ...(post === undefined ? {} : { publishColor: post.publishSource }),
      ...(lightList === undefined || prepared.lightList === undefined
        ? {}
        : {
            lightList: {
              source: lightList.output.source,
              packedLights: lightList.lights as never,
              output: lightList.output as never,
              bindGroupLayout: prepared.lightList.forwardBindGroupLayoutToken
            } as NonNullable<Parameters<typeof createOpaqueRenderSystem>[0]['lightList']>
          }),
      ...(environment === undefined || prepared.environment === undefined
        ? {}
        : {
            environment: {
              buffer: environment.buffer,
              irradianceMap: environment.irradianceMap,
              prefilteredRadianceMap: environment.prefilteredRadianceMap,
              environmentBrdfLut: environment.environmentBrdfLut
            }
          })
    });
    const systems = new RenderSystemRegistry();
    const bgToken = bgSystem !== undefined ? systems.add(bgSystem) : undefined;
    const opaqueToken = systems.add({
      ...opaque.descriptor,
      after: bgToken !== undefined ? [bgToken] : []
    });
    if (post !== undefined) systems.add(post.descriptor(opaqueToken));
    const compiled = compileRenderSystems(systems, {
      views: [prepared.view],
      graph,
      executionPlanOptions: {
        enablePassFusion: this.options.forceSeparatePasses !== true
      }
    });
    let execution: ReturnType<RenderGraphExecutor['execute']>;
    try {
      const lightFrame = prepared.lightList;
      const environmentFrame = prepared.environment;
      const resources = new Map();
      if (environment !== undefined && environmentFrame !== undefined) {
        resources.set(environment.buffer, environmentFrame.buffer);
        resources.set(environment.irradianceMap, environmentFrame.irradianceMap);
        resources.set(environment.prefilteredRadianceMap, environmentFrame.prefilteredRadianceMap);
        resources.set(environment.environmentBrdfLut, environmentFrame.environmentBrdfLut);
      }
      if (lightList !== undefined && lightFrame !== undefined) {
        resources.set(lightList.lights, lightFrame.lights);
        resources.set(lightList.receivers, lightFrame.receivers);
      }
      if (bgContribution !== undefined && bgFrame !== undefined && bgFrame.status === 'ready') {
        resources.set(bgContribution.uniformBuffer, bgFrame.uniformBuffer!);
        resources.set(bgContribution.skyTexture, bgFrame.texture!);
      }
      if (post !== undefined) {
        resources.set(post.uniform, post.prepared.uniformBuffer);
      }
      const renderPipelines = new Map();
      if (lightFrame?.source === 'webgl-fragment')
        renderPipelines.set(lightFrame.recorder.pipelineToken, lightFrame.recorder.pipeline);
      if (post !== undefined)
        renderPipelines.set(post.prepared.pipelineToken, post.prepared.pipeline);
      if (
        bgFrame !== undefined &&
        bgFrame.status === 'ready' &&
        bgFrame.pipelineToken !== undefined
      )
        renderPipelines.set(bgFrame.pipelineToken, bgFrame.pipeline!);
      const bindGroupLayouts = new Map();
      if (lightFrame !== undefined) {
        bindGroupLayouts.set(
          lightFrame.recorder.bindGroupLayoutToken,
          lightFrame.recorder.bindGroupLayout
        );
        bindGroupLayouts.set(
          lightFrame.forwardBindGroupLayoutToken,
          lightFrame.forwardBindGroupLayout
        );
      }
      if (post !== undefined) {
        bindGroupLayouts.set(post.prepared.textureLayoutToken, post.prepared.textureLayout);
        bindGroupLayouts.set(post.prepared.uniformLayoutToken, post.prepared.uniformLayout);
      }
      if (
        bgFrame !== undefined &&
        bgFrame.status === 'ready' &&
        bgFrame.uniformLayoutToken !== undefined &&
        bgFrame.textureLayoutToken !== undefined
      ) {
        bindGroupLayouts.set(bgFrame.uniformLayoutToken, bgFrame.uniformLayout!);
        bindGroupLayouts.set(bgFrame.textureLayoutToken, bgFrame.textureLayout!);
      }
      execution = new RenderGraphExecutor().execute(compiled.plan, {
        device,
        surface,
        preparedDrawResources: opaque.preparedDrawResources,
        ...(resources.size === 0 ? {} : { resources }),
        ...(renderPipelines.size === 0 ? {} : { preparedRenderPipelines: renderPipelines }),
        ...(bindGroupLayouts.size === 0 ? {} : { preparedBindGroupLayouts: bindGroupLayouts }),
        ...(lightFrame?.source === 'gpu-compute'
          ? {
              preparedComputePipelines: new Map([
                [lightFrame.recorder.pipelineToken, lightFrame.recorder.pipeline]
              ])
            }
          : {})
      });
      lightFrame?.retain(execution.submission);
      bgFrame?.retain(execution.submission);
    } catch (error) {
      for (const packet of phase.snapshot.packets) packet.release();
      prepared.lightList?.release();
      prepared.background?.release();
      throw error;
    }
    return Object.freeze({
      frame,
      viewId: prepared.view.id,
      status: 'rendered',
      renderPasses: execution.commandStats.renderPasses,
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

function contributeEnvironment(
  graph: RenderGraphBuilder,
  prepared: Extract<BaselinePreparedFrame, { status: 'ready' }>
) {
  if (prepared.environment === undefined) throw new Error('Baseline Environment input is missing.');
  const origin = {
    kind: 'imported' as const,
    initialState: 'sampled' as const,
    acquire: { kind: 'external-acquire' as const, id: `${prepared.view.id}:environment-input` }
  };
  const textureHandle = (raw: RHITexture, id: string) =>
    graph.createTexture(
      {
        width: raw.width,
        height: raw.height,
        depthOrArrayLayers: raw.depthOrArrayLayers,
        mipLevelCount: raw.descriptor.mipLevelCount ?? 1,
        sampleCount: raw.descriptor.sampleCount ?? 1,
        format: raw.format,
        usage: ['sampled']
      },
      { origin: { ...origin, acquire: { ...origin.acquire, id } } }
    );
  const irradianceMap = textureHandle(
    prepared.environment.irradianceMap,
    `${origin.acquire.id}:irradiance`
  );
  const prefilteredRadianceMap = textureHandle(
    prepared.environment.prefilteredRadianceMap,
    `${origin.acquire.id}:prefiltered-radiance`
  );
  const environmentBrdfLut = textureHandle(
    prepared.environment.environmentBrdfLut,
    `${origin.acquire.id}:brdf-lut`
  );
  const buffer = graph.createBuffer(
    { size: prepared.environment.buffer.size, usage: ['uniform'] },
    {
      origin: {
        kind: 'imported',
        initialState: 'uniform',
        acquire: { kind: 'external-acquire', id: `${origin.acquire.id}:environment` }
      }
    }
  );
  return { buffer, irradianceMap, prefilteredRadianceMap, environmentBrdfLut };
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
    let output: WebGpuLightListBuildOutput | undefined;
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
  const textureHandle = (raw: RHITexture, id: string) =>
    graph.createTexture(
      {
        width: raw.width,
        height: raw.height,
        depthOrArrayLayers: raw.depthOrArrayLayers,
        mipLevelCount: raw.descriptor.mipLevelCount ?? 1,
        sampleCount: raw.descriptor.sampleCount ?? 1,
        format: raw.format,
        usage: ['sampled']
      },
      { origin: { ...origin, acquire: { ...origin.acquire, id } } }
    );
  const lights = textureHandle(prepared.lightList.lights, `${origin.acquire.id}:lights`);
  const receivers = textureHandle(prepared.lightList.receivers, `${origin.acquire.id}:receivers`);
  let output: WebGlFragmentLightListBuildOutput | undefined;
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
