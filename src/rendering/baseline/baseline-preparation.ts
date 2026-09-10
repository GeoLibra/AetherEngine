import {
  STANDARD_LIT_LIST_SHADER_ABI_VERSION,
  STANDARD_LIT_LIST_SHADER_MODULE_KEY,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGPU_SHADER_MODULE,
  createCookedShaderBindingManifest
} from '../../shader';
import type {
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIBuffer,
  RHIResource,
  RHISubmission
} from '../../rhi/contracts';
import {
  compileBindingLayoutPlan,
  createBindingKey,
  createCanonicalKey,
  createPipelineKey,
  DeviceLayoutCache,
  LayoutCache
} from '../pipeline';
import { disposePreparedMesh, prepareMesh, type PreparedMesh } from '../mesh';
import type { PreparedDrawPacket } from '../phase';
import {
  createPreparedBindGroupLayoutToken,
  createPreparedRenderPipelineToken
} from '../../render-graph';
import type { ExtractedView } from '../camera';
import type { RenderEntityId } from '../world';
import type { RenderTransformFact } from '../mesh';
import type {
  BaselineEnvironmentFrame,
  BaselineLightListFrame,
  BaselineRenderingOptions
} from './types';
import {
  LIGHT_LIST_SHADER_MAX_LIGHTS,
  packWebGlLightListInput,
  packWebGpuLightListInput,
  prepareWebGlLightListRecorder,
  prepareWebGpuLightListRecorder,
  type CpuLightListCapacity,
  type LightReceiver,
  type PreparedLight,
  type PreparedWebGlLightListRecorder,
  type PreparedWebGpuLightListRecorder
} from '../lighting';
import {
  createDefaultEnvironmentTextures,
  sharedEnvironmentTextureCache,
  type EnvironmentTextureSet,
  type PreparedEnvironmentBundle
} from '../lighting/environment';
import { prepareBaselinePostColor, type BaselinePostColorPreparation } from './baseline-post-color';
import {
  createBaselineUniformBuffer as uniformBuffer,
  packBaselineMaterialUniform as materialUniform,
  packBaselineObjectUniform as objectUniform,
  packBaselineViewUniform as viewUniform
} from './baseline-uniforms';
import { prepareBackground, type PreparedBackgroundFrame } from '../background/prepare';
import type { ViewBackground } from '../background/types';

export type { BaselinePostColorPreparation } from './baseline-post-color';
export type { BaselineEnvironmentFrame, BaselineLightListFrame } from './types';

const STORAGE_UNIFORM_UPLOAD_BUFFER_USAGE = (1 << 3) | (1 << 6) | (1 << 7);
const STORAGE_UPLOAD_BUFFER_USAGE = (1 << 3) | (1 << 7);
const SAMPLED_UPLOAD_TEXTURE_USAGE = (1 << 2) | (1 << 4);
const EMPTY_DYNAMIC_OFFSETS: readonly number[] = Object.freeze([]);

export const BASELINE_LIGHT_LIST_CAPACITY: CpuLightListCapacity = Object.freeze({
  maxDirectionalLights: 64,
  maxLightsPerReceiver: 16,
  maxLightIndices: 4096
});

import type { NormalizedBaselineRenderingOptions } from './baseline-options';

type RegisteredOptions = NormalizedBaselineRenderingOptions &
  Required<Pick<NormalizedBaselineRenderingOptions, 'mesh' | 'material' | 'featurePolicyKey'>>;

/** Preparation-owned standard-lit GPU resources shared across immutable frame packets. */
export class BaselineStandardLitPreparation {
  private readonly mesh: PreparedMesh;
  private readonly pipeline: ReturnType<
    RegisteredOptions['graphics']['device']['createRenderPipeline']
  >;
  private readonly bindGroupLayouts: readonly ReturnType<
    RegisteredOptions['graphics']['device']['createBindGroupLayout']
  >[];
  private readonly pipelineLayout: ReturnType<
    RegisteredOptions['graphics']['device']['createPipelineLayout']
  >;
  private readonly shaderModule: ReturnType<
    RegisteredOptions['graphics']['device']['createShaderModule']
  >;
  private readonly pipelineKey: string;
  private readonly bindingLayoutHash: string;
  private readonly pendingSubmissions = new Set<Promise<unknown>>();
  private readonly environmentBundle?: PreparedEnvironmentBundle | undefined;
  private readonly environmentBuffer: RHIBuffer;
  private readonly environmentTextures: EnvironmentTextureSet;
  readonly postColor: BaselinePostColorPreparation;
  private readonly postColorOwnedResources: readonly RHIResource[];
  private readonly lightListRecorder:
    PreparedWebGpuLightListRecorder | PreparedWebGlLightListRecorder;
  readonly lightListBindGroupLayoutToken =
    createPreparedBindGroupLayoutToken('standard-lit-light-list');
  private frameAllocationGeneration = 0;
  private disposed = false;

  constructor(private readonly options: RegisteredOptions) {
    const { device } = options.graphics;
    const shaderArtifact =
      options.graphics.backend === 'webgpu'
        ? STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT
        : STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT;
    const shaderModule =
      options.graphics.backend === 'webgpu'
        ? STANDARD_LIT_LIST_WEBGPU_SHADER_MODULE
        : STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE;
    const manifest = createCookedShaderBindingManifest(
      shaderArtifact,
      STANDARD_LIT_LIST_SHADER_ABI_VERSION
    );
    const compiled = compileBindingLayoutPlan(manifest);
    if (compiled.kind !== 'success') {
      throw new Error(`Standard-lit binding layout is invalid: ${compiled.diagnostic.message}`);
    }
    const target = options.graphics.backend;
    const entry = new LayoutCache().resolve({
      plan: compiled.plan,
      layoutRevision: STANDARD_LIT_LIST_SHADER_ABI_VERSION,
      featurePolicyHash: options.featurePolicyKey,
      target,
      deviceGeneration: device.generation
    }).entry;
    const layout = new DeviceLayoutCache().resolve(entry, device);
    if (layout.status === 'unsupported') {
      throw new Error(`Standard-lit device layout is unsupported: ${layout.diagnostic.message}`);
    }
    this.bindGroupLayouts = layout.layout.bindGroupLayouts;
    this.pipelineLayout = layout.layout.pipelineLayout;
    this.shaderModule = device.createShaderModule({
      label: 'aether-standard-lit',
      code: shaderModule
    });
    const { diffuseIrradiance, intensity, radianceTint } = options.environmentLighting;
    if (options.environment !== undefined) {
      this.environmentBundle = sharedEnvironmentTextureCache.acquire(device, options.environment);
      this.environmentTextures = this.environmentBundle.textures;
      const maxLod = this.environmentBundle.maxValidRadianceLod;
      this.environmentBuffer = uniformBuffer(device, [
        ...diffuseIrradiance,
        intensity,
        ...radianceTint,
        maxLod
      ]);
    } else {
      this.environmentBuffer = uniformBuffer(device, [
        ...diffuseIrradiance,
        intensity,
        ...radianceTint,
        2.0
      ]);
      this.environmentTextures = createDefaultEnvironmentTextures(device);
    }
    const postColor = prepareBaselinePostColor(
      device,
      options.graphics.surface.configuration!.format
    );
    this.postColor = postColor.preparation;
    this.postColorOwnedResources = postColor.ownedResources;
    this.lightListRecorder =
      options.graphics.backend === 'webgpu'
        ? prepareWebGpuLightListRecorder(device)
        : prepareWebGlLightListRecorder(device);
    this.pipeline = device.createRenderPipeline({
      label: 'aether-standard-lit',
      layout: this.pipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: 'standardLitVertex',
        buffers: options.mesh.data.streams.map((stream) => ({
          arrayStride: stream.stride,
          attributes: [
            {
              format: stream.format,
              offset: stream.offset,
              shaderLocation: stream.semantic === 'POSITION' ? 0 : 1
            }
          ]
        }))
      },
      primitive: {
        topology: 'triangle-list',
        frontFace: options.mesh.data.frontFace,
        cullMode: 'back'
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less'
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: 'standardLitFragment',
        targets: [{ format: 'rgba16float' }]
      }
    });
    this.mesh = prepareMesh(device, options.mesh.data, {
      assetId: options.mesh.handle.assetId,
      payloadVersion: options.mesh.payloadVersion,
      featurePolicyKey: options.featurePolicyKey,
      abiVersion: 'baseline-mesh-v1'
    }).value;
    this.bindingLayoutHash = compiled.plan.hash;
    this.pipelineKey = createPipelineKey({
      shaderModuleKey: STANDARD_LIT_LIST_SHADER_MODULE_KEY,
      entryPoints: [
        { stage: 'vertex', name: 'standardLitVertex' },
        { stage: 'fragment', name: 'standardLitFragment' }
      ],
      bindingLayoutHash: manifest.layoutHash,
      vertexLayoutHash: createCanonicalKey({
        streams: options.mesh.data.streams.map(({ semantic, format, stride, offset }) => ({
          semantic,
          format,
          stride,
          offset
        }))
      }).hash,
      primitiveStateHash: createCanonicalKey({
        topology: options.mesh.data.topology,
        frontFace: options.mesh.data.frontFace,
        cullMode: 'back'
      }).hash,
      depthStencilStateHash: createCanonicalKey({
        depthTest: true,
        depthWrite: true,
        format: 'depth24plus'
      }).hash,
      blendStateHash: createCanonicalKey({ colorWrite: 'all', blend: null }).hash,
      attachmentFormats: ['rgba16float'],
      depthStencilFormat: 'depth24plus',
      sampleCount: 1,
      featurePolicyHash: options.featurePolicyKey,
      deviceGeneration: device.generation
    }).hash;
  }

  createPacket(input: {
    entity: RenderEntityId;
    transform: RenderTransformFact;
    view: ExtractedView;
  }): PreparedDrawPacket {
    this.assertLive();
    const { device } = this.options.graphics;
    const buffers = [
      uniformBuffer(device, objectUniform(input.transform, input.entity)),
      uniformBuffer(device, viewUniform(input.view)),
      uniformBuffer(device, materialUniform(this.options.material.material))
    ];
    const bindGroups: RHIBindGroup[] = [];
    try {
      for (let group = 0; group < 3; group += 1) {
        bindGroups.push(
          device.createBindGroup({
            layout: this.bindGroupLayouts[group]!,
            entries: [{ binding: 0, resource: { buffer: buffers[group]! } }]
          })
        );
      }
    } catch (error) {
      disposeResources([...bindGroups, ...buffers]);
      throw error;
    }
    return this.packet(input.entity, buffers, bindGroups);
  }

  get lightListBindGroupLayout() {
    return this.bindGroupLayouts[3]!;
  }

  get environmentFrame(): BaselineEnvironmentFrame {
    return Object.freeze({
      buffer: this.environmentBuffer,
      irradianceMap: this.environmentTextures.irradianceMap,
      prefilteredRadianceMap: this.environmentTextures.prefilteredRadianceMap,
      environmentBrdfLut: this.environmentTextures.environmentBrdfLut
    });
  }

  /** Prepares background resources for the given view and background configuration. */
  createBackgroundFrame(
    view: ExtractedView,
    background?: ViewBackground
  ): PreparedBackgroundFrame | undefined {
    const bg = background ?? this.options.background;
    if (bg === undefined || bg.kind === 'none') return undefined;
    const { device } = this.options.graphics;
    const environmentIntensity = this.options.environmentLighting.intensity;
    return prepareBackground({
      device,
      view,
      background: bg,
      colorFormat: 'rgba16float',
      depthFormat: 'depth24plus',
      environmentAsset: this.options.environment,
      environmentCache: sharedEnvironmentTextureCache,
      environmentIntensity,
      environmentRadianceTint: this.options.environmentLighting.radianceTint,
      depthMode: 'standard',
      reconstructionMode: 'vertex'
    });
  }

  /** Uploads immutable backend input resources consumed by one LightList build submission. */
  createLightListFrame(input: {
    viewLayerMask: number;
    lights: readonly PreparedLight[];
    receivers: readonly LightReceiver[];
  }): BaselineLightListFrame {
    this.assertLive();
    const { device } = this.options.graphics;
    if (this.options.graphics.backend === 'webgpu') {
      const packed = packWebGpuLightListInput({ ...input, capacity: BASELINE_LIGHT_LIST_CAPACITY });
      const lightWords = new Uint32Array(4 + LIGHT_LIST_SHADER_MAX_LIGHTS * 12);
      lightWords.set(packed.lights);
      const lights = device.createBuffer({
        size: lightWords.byteLength,
        usage: STORAGE_UNIFORM_UPLOAD_BUFFER_USAGE
      });
      const receivers = device.createBuffer({
        size: Math.max(16, packed.receivers.byteLength),
        usage: STORAGE_UPLOAD_BUFFER_USAGE
      });
      device.queue.writeBuffer(lights, 0, lightWords);
      device.queue.writeBuffer(receivers, 0, packed.receivers);
      return this.ownedLightListFrame({
        source: 'gpu-compute',
        lights,
        receivers,
        receiverCount: input.receivers.length,
        recorder: this.lightListRecorder as PreparedWebGpuLightListRecorder,
        forwardBindGroupLayoutToken: this.lightListBindGroupLayoutToken,
        forwardBindGroupLayout: this.lightListBindGroupLayout
      });
    }
    const maxTextureDimension2D = device.capabilities.limits.maxTextureDimension2D;
    if (maxTextureDimension2D === undefined)
      throw new Error('WebGL2 LightList requires maxTextureDimension2D.');
    const packed = packWebGlLightListInput({
      ...input,
      capacity: BASELINE_LIGHT_LIST_CAPACITY,
      maxTextureDimension2D
    });
    const texture = (height: number, words: Uint32Array) => {
      const result = device.createTexture({
        size: [packed.width, height],
        format: 'rgba32uint',
        usage: SAMPLED_UPLOAD_TEXTURE_USAGE
      });
      device.queue.writeTexture(
        { texture: result },
        words,
        { bytesPerRow: packed.width * 16, rowsPerImage: height },
        { width: packed.width, height }
      );
      return result;
    };
    return this.ownedLightListFrame({
      source: 'webgl-fragment',
      lights: texture(packed.lightsHeight, packed.lights),
      receivers: texture(packed.receiversHeight, packed.receivers),
      receiverCount: input.receivers.length,
      maxTextureDimension2D,
      recorder: this.lightListRecorder as PreparedWebGlLightListRecorder,
      forwardBindGroupLayoutToken: this.lightListBindGroupLayoutToken,
      forwardBindGroupLayout: this.lightListBindGroupLayout
    });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.pendingSubmissions]);
    disposePreparedMesh(this.mesh);
    this.pipeline.dispose();
    this.lightListRecorder.dispose();
    this.environmentBuffer.dispose();
    if (this.environmentBundle !== undefined) {
      this.environmentBundle.release();
    } else {
      disposeResources([
        this.environmentTextures.irradianceMap,
        this.environmentTextures.prefilteredRadianceMap
      ]);
    }
    disposeResources(this.postColorOwnedResources);
    this.shaderModule.dispose();
    this.pipelineLayout.dispose();
    disposeResources(this.bindGroupLayouts);
  }

  private packet(
    entity: RenderEntityId,
    buffers: readonly RHIBuffer[],
    bindGroups: readonly RHIBindGroup[]
  ): PreparedDrawPacket {
    const submesh = this.mesh.submeshes[0]!;
    let released = false;
    let retained = false;
    const bindingKey = createBindingKey({
      bindingLayoutHash: this.bindingLayoutHash,
      resources: [],
      bufferAllocationGeneration: ++this.frameAllocationGeneration,
      ringGeneration: 1,
      dynamicOffsets: [],
      deviceGeneration: this.options.graphics.device.generation
    });
    const releaseFrameResources = (): void => disposeResources([...bindGroups, ...buffers]);
    return Object.freeze({
      entity,
      phase: 'opaque',
      pipelineKey: this.pipelineKey,
      materialKey: this.options.material.handle.assetId,
      meshKey: this.options.mesh.handle.assetId,
      bindingKey: bindingKey.hash,
      drawKey: `${entity}:0`,
      distance: 0,
      insertionOrder: 0,
      pipeline: this.pipeline,
      bindingSet: Object.freeze({
        bindingKey,
        bindGroups: Object.freeze([...bindGroups]),
        dynamicOffsetsByGroup: Object.freeze(bindGroups.map(() => EMPTY_DYNAMIC_OFFSETS)),
        deviceGeneration: this.options.graphics.device.generation
      }),
      vertexBuffers: this.mesh.vertexBuffers,
      indexBuffer: this.mesh.indexBuffer!,
      indexFormat: this.mesh.layout.indexFormat!,
      firstIndex: submesh.start,
      indexCount: submesh.count,
      get released() {
        return released;
      },
      get retentionReady() {
        return !released;
      },
      retain: (submission: RHISubmission) => {
        if (released || retained) throw new Error('Baseline draw packet cannot be retained.');
        retained = true;
        const pending = submission.done.finally(() => {
          releaseFrameResources();
          this.pendingSubmissions.delete(pending);
        });
        this.pendingSubmissions.add(pending);
      },
      release: () => {
        if (released) return;
        released = true;
        if (!retained) releaseFrameResources();
      }
    });
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Standard-lit preparation has been disposed.');
  }

  private ownedLightListFrame<T extends Omit<BaselineLightListFrame, 'release' | 'retain'>>(
    value: T
  ): BaselineLightListFrame {
    let released = false;
    let retained = false;
    const resources: readonly RHIResource[] = [value.lights, value.receivers];
    return Object.freeze({
      ...value,
      release: () => {
        if (released) return;
        released = true;
        if (!retained) disposeResources(resources);
      },
      retain: (submission: RHISubmission) => {
        if (released || retained) throw new Error('Baseline LightList frame cannot be retained.');
        retained = true;
        const pending = submission.done.finally(() => {
          disposeResources(resources);
          this.pendingSubmissions.delete(pending);
        });
        this.pendingSubmissions.add(pending);
      }
    }) as BaselineLightListFrame;
  }
}

function disposeResources(resources: readonly RHIResource[]): void {
  for (const resource of [...resources].reverse()) resource.dispose();
}
