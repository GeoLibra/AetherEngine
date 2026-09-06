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
import type { RHITexture } from '../../rhi/contracts';

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
    const lightList =
      prepared.lightList === undefined ? undefined : contributeLightList(graph, prepared);
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
      ...(lightList === undefined || prepared.lightList === undefined
        ? {}
        : {
            environment: {
              buffer: lightList.environment,
              irradianceMap: lightList.irradianceMap,
              prefilteredRadianceMap: lightList.prefilteredRadianceMap,
              environmentBrdfLut: lightList.environmentBrdfLut
            }
          }),
      ...(post === undefined
        ? {}
        : {
            colorTarget: post.hdrTarget,
            present: false,
            publishColor: post.publishSource
          })
    });
    const systems = new RenderSystemRegistry();
    const opaqueToken = systems.add(opaque.descriptor);
    if (post !== undefined) systems.add(post.descriptor(opaqueToken));
    const compiled = compileRenderSystems(systems, { views: [prepared.view], graph });
    let execution: ReturnType<RenderGraphExecutor['execute']>;
    try {
      const lightFrame = prepared.lightList;
      const resources = new Map();
      if (lightList !== undefined && lightFrame !== undefined) {
        resources.set(lightList.lights, lightFrame.lights);
        resources.set(lightList.receivers, lightFrame.receivers);
        resources.set(lightList.environment, lightFrame.environmentBuffer);
        resources.set(lightList.irradianceMap, lightFrame.irradianceMap);
        resources.set(lightList.prefilteredRadianceMap, lightFrame.prefilteredRadianceMap);
        resources.set(lightList.environmentBrdfLut, lightFrame.environmentBrdfLut);
      }
      if (post !== undefined) {
        resources.set(post.uniform, post.prepared.uniformBuffer);
      }
      const renderPipelines = new Map();
      if (lightFrame?.source === 'webgl-fragment')
        renderPipelines.set(lightFrame.recorder.pipelineToken, lightFrame.recorder.pipeline);
      if (post !== undefined)
        renderPipelines.set(post.prepared.pipelineToken, post.prepared.pipeline);
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
    } catch (error) {
      for (const packet of phase.snapshot.packets) packet.release();
      prepared.lightList?.release();
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

function createPostColorContribution(
  graph: RenderGraphBuilder,
  prepared: Extract<BaselinePreparedFrame, { status: 'ready' }>,
  configuration: NonNullable<BaselineRenderingOptions['graphics']['surface']['configuration']>
) {
  const postColor = prepared.postColor!;
  const hdrTarget = graph.createTexture({
    width: configuration.width,
    height: configuration.height,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format: 'rgba16float',
    usage: ['color-attachment', 'sampled']
  });
  const uniform = graph.createBuffer(
    { size: postColor.uniformBuffer.size, usage: ['uniform'] },
    {
      origin: {
        kind: 'imported',
        initialState: 'uniform',
        acquire: { kind: 'external-acquire', id: `${prepared.view.id}:post-color` }
      }
    }
  );
  let source: import('../../render-graph').TextureHandle | undefined;
  return {
    hdrTarget,
    uniform,
    prepared: postColor,
    publishSource(value: import('../../render-graph').TextureHandle) {
      source = value;
    },
    descriptor(after: import('../../render-graph').RenderSystemToken) {
      return {
        id: 'post-color',
        scope: 'per-view' as const,
        after: [after],
        runIf: ({ view }: import('../../render-graph').RenderSystemConditionContext) =>
          view?.id === prepared.view.id,
        setup(pass: import('../../render-graph').PassBuilder) {
          if (source === undefined) throw new Error('Opaque HDR output was not published.');
          const sceneColor = pass.readTexture(source, 'sampled');
          const postUniform = pass.readBuffer(uniform, 'uniform');
          const surfaceTarget = pass.createTexture(
            attachment(
              configuration.width,
              configuration.height,
              configuration.format,
              'color-attachment'
            ),
            {
              origin: {
                kind: 'imported',
                initialState: 'undefined',
                acquire: { kind: 'external-acquire', id: prepared.view.surface }
              }
            }
          );
          const output = pass.writeTexture(surfaceTarget, 'color-attachment');
          pass.presentTexture(output, { kind: 'surface-frame', id: prepared.view.surface });
          return Object.freeze({ sceneColor, uniform: postUniform, output });
        },
        run(
          context: import('../../render-graph').RestrictedPassContext,
          resources: {
            sceneColor: import('../../render-graph').TextureHandle;
            uniform: import('../../render-graph').BufferHandle;
            output: import('../../render-graph').TextureHandle;
          }
        ) {
          const textureGroup = context.device.createBindGroup({
            label: 'aether-post-color-texture',
            layout: context.bindGroupLayout(postColor.textureLayoutToken),
            entries: [
              { binding: 0, resource: context.texture(resources.sceneColor, 'sampled') },
              {
                binding: 1,
                resource: context.device.createSampler({ minFilter: 'linear', magFilter: 'linear' })
              }
            ]
          });
          const uniformGroup = context.device.createBindGroup({
            label: 'aether-post-color-uniform',
            layout: context.bindGroupLayout(postColor.uniformLayoutToken),
            entries: [{ binding: 0, resource: context.buffer(resources.uniform, 'uniform') }]
          });
          const pipeline = context.renderPipeline(postColor.pipelineToken);
          const raster = context.beginRaster({
            label: 'post-color',
            colorAttachments: [
              {
                texture: resources.output,
                loadOp: 'clear',
                storeOp: 'store',
                clearValue: { r: 0, g: 0, b: 0, a: 1 }
              }
            ]
          });
          raster.setViewport(0, 0, configuration.width, configuration.height, 0, 1);
          raster.setScissorRect(0, 0, configuration.width, configuration.height);
          raster.setPipeline(pipeline);
          raster.setBindGroup(0, textureGroup);
          raster.setBindGroup(1, uniformGroup);
          raster.draw(3);
          raster.end();
        }
      };
    }
  };
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
    prepared.lightList.irradianceMap,
    `${origin.acquire.id}:irradiance`
  );
  const prefilteredRadianceMap = textureHandle(
    prepared.lightList.prefilteredRadianceMap,
    `${origin.acquire.id}:prefiltered-radiance`
  );
  const environmentBrdfLut = textureHandle(
    prepared.lightList.environmentBrdfLut,
    `${origin.acquire.id}:brdf-lut`
  );
  if (prepared.lightList.source === 'gpu-compute') {
    const environment = graph.createBuffer(
      { size: prepared.lightList.environmentBuffer.size, usage: ['uniform'] },
      {
        origin: {
          kind: 'imported',
          initialState: 'uniform',
          acquire: { kind: 'external-acquire', id: `${origin.acquire.id}:environment` }
        }
      }
    );
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
    return {
      lights,
      receivers,
      environment,
      irradianceMap,
      prefilteredRadianceMap,
      environmentBrdfLut,
      output
    };
  }
  const lights = textureHandle(prepared.lightList.lights, `${origin.acquire.id}:lights`);
  const receivers = textureHandle(prepared.lightList.receivers, `${origin.acquire.id}:receivers`);
  const environment = graph.createBuffer(
    { size: prepared.lightList.environmentBuffer.size, usage: ['uniform'] },
    {
      origin: {
        kind: 'imported',
        initialState: 'uniform',
        acquire: { kind: 'external-acquire', id: `${origin.acquire.id}:environment` }
      }
    }
  );
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
  return {
    lights,
    receivers,
    environment,
    irradianceMap,
    prefilteredRadianceMap,
    environmentBrdfLut,
    output
  };
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
