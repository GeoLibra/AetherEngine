import {
  STANDARD_LIT_LIST_SHADER_ABI_VERSION,
  STANDARD_LIT_LIST_SHADER_MODULE_KEY,
  STANDARD_LIT_LIST_WEBGL2_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE,
  STANDARD_LIT_LIST_WEBGPU_SHADER_ARTIFACT,
  STANDARD_LIT_LIST_WEBGPU_SHADER_MODULE,
  STANDARD_LIT_CLUSTER_SHADER_ABI_VERSION,
  STANDARD_LIT_CLUSTER_SHADER_MODULE_KEY,
  STANDARD_LIT_CLUSTER_WEBGPU_SHADER_ARTIFACT,
  STANDARD_LIT_CLUSTER_WEBGPU_SHADER_MODULE,
  STANDARD_SHADOW_SHADER_ABI_VERSION,
  STANDARD_SHADOW_SHADER_ARTIFACT,
  STANDARD_SHADOW_SHADER_MODULE,
  STANDARD_SHADOW_SHADER_MODULE_KEY,
  createCookedShaderBindingManifest
} from '../../shader';
import type {
  RHIBindGroup,
  RHIBindGroupLayout,
  RHIBuffer,
  RHIRenderPipeline,
  RHITexture,
  RHIResource,
  RHISubmission,
  GPUVertexBufferLayout,
  GPUBlendState
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
import {
  prepareStandardLitTextureBindings,
  type PreparedStandardLitTextureBindings
} from '../material';
import { StandardLitMaterialSchema } from '../../material';
import type { PreparedDrawPacket } from '../phase';
import { createPreparedToken, type PreparedBindGroupLayoutToken } from '../../render-graph';
import type { ExtractedView } from '../camera';
import type { RenderEntityId } from '../world';
import { ReadonlyMapSnapshot } from '../world/readonly-collection-snapshot';
import type { RenderTransformFact } from '../mesh';
import type {
  BaselineEnvironmentFrame,
  BaselineDirectionalShadowFrame,
  BaselineLocalShadowFrame,
  BaselineLightListFrame,
  BaselineRenderingOptions
} from './types';
import type { EnvironmentAsset } from '../../assets';
import {
  BuiltInFeature,
  BuiltInFeatureImplementation,
  LIGHT_LIST_LIGHT_WORDS,
  LIGHT_LIST_HEADER_WORDS,
  LIGHT_LIST_SHADER_MAX_LIGHTS,
  CLUSTER_FORWARD_HEADER_WORDS,
  CLUSTER_FORWARD_MAX_SLICES,
  CLUSTER_FORWARD_SLICE_WORDS,
  packClusterForwardMetadata,
  packClusterGridForWebGpu,
  packWebGpuClusterLights,
  packWebGlLightListInput,
  prepareWebGpuClusterLightListRecorder,
  packWebGpuLightListInput,
  prepareWebGlLightListRecorder,
  prepareWebGpuLightListRecorder,
  calculateWebGlLightListPacking,
  type CpuBoundedLightListFrameInput,
  type CpuLightListCapacity,
  type CpuLightListResult,
  type LightReceiver,
  type PreparedLight,
  type PreparedWebGlLightListRecorder,
  type PreparedWebGpuLightListRecorder,
  type PreparedWebGpuClusterLightListRecorder,
  type ClusterCapacity,
  type ClusterGrid,
  type ShadowRequest,
  packLocalShadowReceiverUniform,
  type LocalShadowReceiverRecord,
  type WebGlFragmentLightListBuildContext,
  type WebGpuLightListBuildContext
} from '../lighting';
import {
  packCpuLightListForWebGpu,
  packCpuLightListForWebGl,
  uploadCpuLightListWebGpu,
  uploadCpuLightListWebGl
} from './light-list';
import type { RuntimeFeatureImplementation } from '../../feature-policy';
import type { NormalizedBaselineRenderingOptions } from './baseline-options';
import type { PreparedFeaturePolicy, RenderFeatureImplementation } from '../../feature-policy';
import {
  BASELINE_LIGHT_LIST_CAPACITY,
  createBaselineLightListImplementation,
  isPreparedFeaturePolicy,
  resolveBaselineFeaturePolicy,
  validateBaselineLightListCapacity,
  type BaselineLightListImplementation
} from './baseline-feature-policy';
import { shadowDepthFormat } from '../lighting/shadow';
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
  packBaselineShadowMaterialUniform as shadowMaterialUniform,
  packBaselineViewUniform as viewUniform
} from './baseline-uniforms';
import { prepareBackground, type PreparedBackgroundFrame } from '../background/prepare';
import type { ViewBackground } from '../background/types';

export type { BaselinePostColorPreparation } from './baseline-post-color';
export type { BaselineEnvironmentFrame, BaselineLightListFrame } from './types';
export { BASELINE_LIGHT_LIST_CAPACITY };

const STORAGE_UNIFORM_UPLOAD_BUFFER_USAGE = (1 << 3) | (1 << 6) | (1 << 7);
const STORAGE_UPLOAD_BUFFER_USAGE = (1 << 3) | (1 << 7);
const SAMPLED_UPLOAD_TEXTURE_USAGE = (1 << 2) | (1 << 4);
const EMPTY_DYNAMIC_OFFSETS: readonly number[] = Object.freeze([]);

type RegisteredOptions = Omit<
  NormalizedBaselineRenderingOptions,
  'featurePolicy' | 'featurePolicyKey' | 'environment' | 'sampleCount'
> &
  Required<Pick<NormalizedBaselineRenderingOptions, 'mesh' | 'material'>> & {
    readonly environment?: EnvironmentAsset | undefined;
    readonly featurePolicy?: PreparedFeaturePolicy | undefined;
    readonly featurePolicyKey?: string | undefined;
    /** Direct preparation tests may omit this; normalized runtime options always provide it. */
    readonly sampleCount?: 1 | 4 | undefined;
  };

/** Preparation-owned standard-lit GPU resources shared across immutable frame packets. */
export class BaselineStandardLitPreparation {
  /** Effective pipeline sample count; direct preparation tests default to single sample. */
  readonly sampleCount: 1 | 4;
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
  private readonly clusterShaderModule?: ReturnType<
    RegisteredOptions['graphics']['device']['createShaderModule']
  >;
  private readonly clusterPipeline?: ReturnType<
    RegisteredOptions['graphics']['device']['createRenderPipeline']
  >;
  private readonly clusterBindGroupLayouts?: readonly RHIBindGroupLayout[];
  private readonly clusterPipelineLayout?: ReturnType<
    RegisteredOptions['graphics']['device']['createPipelineLayout']
  >;
  private readonly shadowShaderModule: ReturnType<
    RegisteredOptions['graphics']['device']['createShaderModule']
  >;
  private readonly shadowPipeline: ReturnType<
    RegisteredOptions['graphics']['device']['createRenderPipeline']
  >;
  private readonly shadowBindGroupLayouts: readonly RHIBindGroupLayout[];
  private readonly shadowPipelineLayout: ReturnType<
    RegisteredOptions['graphics']['device']['createPipelineLayout']
  >;
  private readonly pipelineKey: string;
  private readonly bindingLayoutHash: string;
  private readonly clusterPipelineKey?: string;
  private readonly clusterBindingLayoutHash?: string;
  private readonly pendingSubmissions = new Set<Promise<unknown>>();
  private readonly environmentBundle?: PreparedEnvironmentBundle | undefined;
  private readonly environmentBuffer: RHIBuffer;
  private readonly environmentTextures: EnvironmentTextureSet;
  private readonly materialTextures: PreparedStandardLitTextureBindings;
  private readonly disabledShadowBuffer: RHIBuffer;
  private readonly disabledLocalShadowBuffer: RHIBuffer;
  private readonly disabledShadowTexture: RHITexture;
  private readonly shadowFormat: 'depth32float' | 'depth24plus';
  readonly postColor: BaselinePostColorPreparation;
  private environmentIntensity: number;
  private readonly defaultColorBuffer: RHIBuffer;
  private readonly hasColor0: boolean;
  private readonly postColorOwnedResources: readonly RHIResource[];
  private readonly featurePolicy: PreparedFeaturePolicy;
  private readonly featurePolicyKey: string;
  private readonly lightListImplementation: BaselineLightListImplementation;
  private readonly lightListCapacity: CpuLightListCapacity;
  private readonly lightListRecorder:
    PreparedWebGpuLightListRecorder | PreparedWebGlLightListRecorder | undefined;
  private readonly clusterLightListRecorder?: PreparedWebGpuClusterLightListRecorder;
  private readonly clusterCapacity: ClusterCapacity;
  readonly lightListBindGroupLayoutToken = createPreparedToken(
    'bind-group-layout',
    'standard-lit-light-list'
  );
  readonly clusterLightListBindGroupLayoutToken = createPreparedToken(
    'bind-group-layout',
    'standard-lit-cluster-light-list'
  );
  private frameAllocationGeneration = 0;
  private disposed = false;

  constructor(private readonly options: RegisteredOptions) {
    this.sampleCount = options.sampleCount ?? 1;
    this.environmentIntensity = options.environmentLighting.intensity;
    const { device } = options.graphics;
    this.shadowFormat = shadowDepthFormat(options.graphics.backend);
    this.hasColor0 = options.mesh.data.streams.some((s) => s.semantic === 'COLOR_0');
    this.defaultColorBuffer = device.createBuffer({
      size: 16,
      usage: (1 << 3) | (1 << 5)
    });
    device.queue.writeBuffer(this.defaultColorBuffer, 0, new Float32Array([1, 1, 1, 1]));

    const featurePolicy = isPreparedFeaturePolicy(options.featurePolicy)
      ? options.featurePolicy
      : resolveBaselineFeaturePolicy({
          device,
          viewId: options.viewId
        });
    if (featurePolicy.snapshot.deviceGeneration !== device.generation) {
      throw new Error(
        `FeaturePolicy deviceGeneration (${featurePolicy.snapshot.deviceGeneration}) does not match current device generation (${device.generation}).`
      );
    }
    this.featurePolicy = featurePolicy;
    const featurePolicyKey =
      options.featurePolicyKey ??
      featurePolicy.snapshot.cacheDomainHashes.get('shader-pipeline') ??
      featurePolicy.snapshot.hash;
    if (!featurePolicyKey || !featurePolicyKey.trim()) {
      throw new Error('Baseline preparation featurePolicyKey must be non-empty.');
    }
    this.featurePolicyKey = featurePolicyKey;

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
      featurePolicyHash: this.featurePolicyKey,
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
      label: 'aether-standard-lit-list',
      code:
        target === 'webgl2'
          ? STANDARD_LIT_LIST_WEBGL2_SHADER_MODULE
          : STANDARD_LIT_LIST_WEBGPU_SHADER_MODULE
    });
    if (options.graphics.backend === 'webgpu') {
      const clusterManifest = createCookedShaderBindingManifest(
        STANDARD_LIT_CLUSTER_WEBGPU_SHADER_ARTIFACT,
        STANDARD_LIT_CLUSTER_SHADER_ABI_VERSION
      );
      const clusterCompiled = compileBindingLayoutPlan(clusterManifest);
      if (clusterCompiled.kind !== 'success') {
        throw new Error(
          `Clustered standard-lit binding layout is invalid: ${clusterCompiled.diagnostic.message}`
        );
      }
      const clusterEntry = new LayoutCache().resolve({
        plan: clusterCompiled.plan,
        layoutRevision: STANDARD_LIT_CLUSTER_SHADER_ABI_VERSION,
        featurePolicyHash: this.featurePolicyKey,
        target: 'webgpu',
        deviceGeneration: device.generation
      }).entry;
      const clusterLayout = new DeviceLayoutCache().resolve(clusterEntry, device);
      if (clusterLayout.status === 'unsupported') {
        throw new Error(
          `Clustered standard-lit device layout is unsupported: ${clusterLayout.diagnostic.message}`
        );
      }
      this.clusterBindGroupLayouts = clusterLayout.layout.bindGroupLayouts;
      this.clusterPipelineLayout = clusterLayout.layout.pipelineLayout;
      this.clusterBindingLayoutHash = clusterCompiled.plan.hash;
      this.clusterShaderModule = device.createShaderModule({
        label: 'aether-standard-lit-cluster',
        code: STANDARD_LIT_CLUSTER_WEBGPU_SHADER_MODULE
      });
    }
    const shadowManifest = createCookedShaderBindingManifest(
      STANDARD_SHADOW_SHADER_ARTIFACT,
      STANDARD_SHADOW_SHADER_ABI_VERSION
    );
    const shadowCompiled = compileBindingLayoutPlan(shadowManifest);
    if (shadowCompiled.kind !== 'success') {
      throw new Error(
        `Standard shadow binding layout is invalid: ${shadowCompiled.diagnostic.message}`
      );
    }
    const shadowEntry = new LayoutCache().resolve({
      plan: shadowCompiled.plan,
      layoutRevision: STANDARD_SHADOW_SHADER_ABI_VERSION,
      featurePolicyHash: this.featurePolicyKey,
      target,
      deviceGeneration: device.generation
    }).entry;
    const shadowLayout = new DeviceLayoutCache().resolve(shadowEntry, device);
    if (shadowLayout.status === 'unsupported') {
      throw new Error(
        `Standard shadow device layout is unsupported: ${shadowLayout.diagnostic.message}`
      );
    }
    this.shadowBindGroupLayouts = shadowLayout.layout.bindGroupLayouts;
    this.shadowPipelineLayout = shadowLayout.layout.pipelineLayout;
    this.shadowShaderModule = device.createShaderModule({
      label: 'aether-standard-shadow',
      code: STANDARD_SHADOW_SHADER_MODULE
    });
    const parameters = options.material.material.instance.parameters;
    this.materialTextures = prepareStandardLitTextureBindings({
      device,
      textureIds: [
        parameters.get(StandardLitMaterialSchema.fields.baseColorTexture).assetId,
        parameters.get(StandardLitMaterialSchema.fields.metallicRoughnessTexture).assetId,
        parameters.get(StandardLitMaterialSchema.fields.normalTexture).assetId,
        parameters.get(StandardLitMaterialSchema.fields.occlusionTexture).assetId,
        parameters.get(StandardLitMaterialSchema.fields.emissiveTexture).assetId
      ],
      samplerId: parameters.get(StandardLitMaterialSchema.fields.sampler).assetId,
      ...(options.materialResources === undefined ? {} : { resolver: options.materialResources })
    });
    this.disabledShadowBuffer = uniformBuffer(device, new Uint32Array(96));
    this.disabledLocalShadowBuffer = uniformBuffer(device, new Uint32Array(324));
    // The standard-lit binding is always a depth texture array, even when CSM is disabled.
    this.disabledShadowTexture = device.createTexture({
      size: [1, 1, 4],
      format: this.shadowFormat,
      usage: (1 << 2) | (1 << 4)
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
    const lightListDecision = this.featurePolicy.snapshot.decisions.get(
      BuiltInFeature.LightListBuild
    );
    if (lightListDecision === undefined || lightListDecision.implementation === null) {
      throw new Error('Baseline standard-lit requires a resolved LightListBuild feature policy.');
    }
    this.lightListCapacity =
      (this.featurePolicy.prepared.get(BuiltInFeature.LightListBuild) as CpuLightListCapacity) ??
      BASELINE_LIGHT_LIST_CAPACITY;
    validateBaselineLightListCapacity(this.lightListCapacity);
    this.clusterCapacity = Object.freeze({
      maxDirectionalLights: this.lightListCapacity.maxDirectionalLights,
      maxLightsPerCluster: this.lightListCapacity.maxLightsPerReceiver,
      maxClusterIndices: this.lightListCapacity.maxLightIndices
    });
    this.lightListImplementation = createBaselineLightListImplementation(
      lightListDecision.implementation,
      this.lightListCapacity,
      device.capabilities.limits.maxTextureDimension2D ?? 2048
    );

    if (lightListDecision.implementation === BuiltInFeatureImplementation.WebGpuComputeLightList) {
      this.lightListRecorder = prepareWebGpuLightListRecorder(device);
      this.clusterLightListRecorder = prepareWebGpuClusterLightListRecorder(device);
    } else if (
      lightListDecision.implementation === BuiltInFeatureImplementation.WebGlFragmentLightList
    ) {
      this.lightListRecorder = prepareWebGlLightListRecorder(device);
    } else if (
      lightListDecision.implementation === BuiltInFeatureImplementation.CpuBoundedLightList
    ) {
      this.lightListRecorder = undefined;
    } else {
      throw new Error(
        `Unsupported baseline LightListBuild implementation: ${lightListDecision.implementation}`
      );
    }

    const cullMode = options.material.material.asset.renderState.cullMode ?? 'back';
    const vertexBuffersLayout: GPUVertexBufferLayout[] = options.mesh.data.streams.map(
      (stream) => ({
        arrayStride: stream.stride,
        attributes: [
          {
            format: stream.format,
            offset: stream.offset,
            shaderLocation: standardLitShaderLocation(stream.semantic)
          }
        ]
      })
    );
    if (!this.hasColor0) {
      vertexBuffersLayout.push({
        arrayStride: 16,
        stepMode: 'instance',
        attributes: [
          {
            format: 'float32x4',
            offset: 0,
            shaderLocation: 5
          }
        ]
      });
    }

    const isTransparent = options.material.material.asset.renderState.surface === 'transparent';
    const blend: GPUBlendState | undefined = isTransparent
      ? {
          color: {
            srcFactor: 'src-alpha',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add'
          },
          alpha: {
            srcFactor: 'one',
            dstFactor: 'one-minus-src-alpha',
            operation: 'add'
          }
        }
      : undefined;

    this.pipeline = device.createRenderPipeline({
      label: 'aether-standard-lit-forward',
      layout: this.pipelineLayout,
      vertex: {
        module: this.shaderModule,
        entryPoint: 'standardLitVertex',
        buffers: vertexBuffersLayout
      },
      primitive: {
        topology: 'triangle-list',
        frontFace: options.mesh.data.frontFace,
        cullMode
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: options.material.material.asset.renderState.depthWrite ?? true,
        depthCompare: 'less'
      },
      fragment: {
        module: this.shaderModule,
        entryPoint: 'standardLitFragment',
        targets: [
          blend !== undefined ? { format: 'rgba16float', blend } : { format: 'rgba16float' }
        ]
      },
      multisample: { count: this.sampleCount }
    });
    if (this.clusterPipelineLayout !== undefined && this.clusterShaderModule !== undefined) {
      this.clusterPipeline = device.createRenderPipeline({
        label: 'aether-standard-lit-cluster-forward',
        layout: this.clusterPipelineLayout,
        vertex: {
          module: this.clusterShaderModule,
          entryPoint: 'standardLitVertex',
          buffers: vertexBuffersLayout
        },
        primitive: {
          topology: 'triangle-list',
          frontFace: options.mesh.data.frontFace,
          cullMode
        },
        depthStencil: {
          format: 'depth24plus',
          depthWriteEnabled: options.material.material.asset.renderState.depthWrite ?? true,
          depthCompare: 'less'
        },
        fragment: {
          module: this.clusterShaderModule,
          entryPoint: 'standardLitFragment',
          targets: [
            blend !== undefined ? { format: 'rgba16float', blend } : { format: 'rgba16float' }
          ]
        },
        multisample: { count: this.sampleCount }
      });
    }
    this.shadowPipeline = device.createRenderPipeline({
      label: 'aether-standard-shadow',
      layout: this.shadowPipelineLayout,
      vertex: {
        module: this.shadowShaderModule,
        entryPoint: 'standardShadowVertex',
        buffers: vertexBuffersLayout
      },
      primitive: {
        topology: 'triangle-list',
        frontFace: options.mesh.data.frontFace,
        cullMode
      },
      depthStencil: {
        format: this.shadowFormat,
        depthWriteEnabled: true,
        depthCompare: 'less'
      },
      fragment: {
        module: this.shadowShaderModule,
        entryPoint: 'standardShadowFragment',
        targets: []
      }
    });
    this.mesh = prepareMesh(device, options.mesh.data, {
      assetId: options.mesh.handle.assetId,
      payloadVersion: options.mesh.payloadVersion,
      featurePolicyKey: this.featurePolicyKey,
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
        cullMode
      }).hash,
      depthStencilStateHash: createCanonicalKey({
        depthTest: true,
        depthWrite: options.material.material.asset.renderState.depthWrite ?? true,
        format: 'depth24plus'
      }).hash,
      blendStateHash: createCanonicalKey({ colorWrite: 'all', blend: blend ?? null }).hash,
      attachmentFormats: ['rgba16float'],
      depthStencilFormat: 'depth24plus',
      sampleCount: this.sampleCount,
      featurePolicyHash: this.featurePolicyKey,
      deviceGeneration: device.generation
    }).hash;
    if (this.clusterPipeline !== undefined) {
      this.clusterPipelineKey = createCanonicalKey({
        pipeline: this.pipelineKey,
        shaderModuleKey: STANDARD_LIT_CLUSTER_SHADER_MODULE_KEY
      }).hash;
    }
  }

  createPacket(input: {
    entity: RenderEntityId;
    transform: RenderTransformFact;
    view: ExtractedView;
    /** Selects the WebGPU clustered-forward shader and its group-3 ABI. */
    lighting?: 'receiver-list' | 'clustered';
  }): PreparedDrawPacket {
    this.assertLive();
    const clustered = input.lighting === 'clustered';
    if (
      clustered &&
      (this.clusterBindGroupLayouts === undefined || this.clusterPipeline === undefined)
    ) {
      throw new Error(
        'Clustered StandardLit packets require the WebGPU clustered-forward pipeline.'
      );
    }
    const bindGroupLayouts = clustered ? this.clusterBindGroupLayouts! : this.bindGroupLayouts;
    const { device } = this.options.graphics;
    const buffers = [
      uniformBuffer(device, objectUniform(input.transform, input.entity)),
      uniformBuffer(device, viewUniform(input.view)),
      uniformBuffer(device, materialUniform(this.options.material.material))
    ];
    const bindGroups: RHIBindGroup[] = [];
    try {
      for (let group = 0; group < 3; group += 1) {
        const entries =
          group === 2
            ? [
                { binding: 0, resource: { buffer: buffers[group]! } },
                ...this.materialTextures.views.map((view, index) => ({
                  binding: index + 1,
                  resource: view
                })),
                { binding: 6, resource: this.materialTextures.sampler }
              ]
            : [{ binding: 0, resource: { buffer: buffers[group]! } }];
        bindGroups.push(
          device.createBindGroup({
            layout: bindGroupLayouts[group]!,
            entries
          })
        );
      }
    } catch (error) {
      disposeResources([...bindGroups, ...buffers]);
      throw error;
    }
    return this.packet(
      input.entity,
      buffers,
      bindGroups,
      clustered
        ? {
            pipeline: this.clusterPipeline!,
            phase:
              this.options.material.material.asset.renderState.surface === 'transparent'
                ? 'transparent'
                : this.options.material.material.asset.renderState.surface === 'alpha-mask'
                  ? 'alpha-test'
                  : 'opaque',
            pipelineKey: this.clusterPipelineKey!,
            drawKey: `${input.entity}:clustered`,
            bindingLayoutHash: this.clusterBindingLayoutHash!
          }
        : undefined
    );
  }

  /** Creates one cascade-specific depth caster packet with alpha coverage matching StandardLit. */
  createShadowPacket(input: {
    entity: RenderEntityId;
    transform: RenderTransformFact;
    viewProjection: ArrayLike<number>;
    cascade: number;
  }): PreparedDrawPacket {
    this.assertLive();
    if (input.viewProjection.length !== 16) {
      throw new Error('Standard shadow view-projection matrix must contain sixteen values.');
    }
    if (this.options.material.material.asset.renderState.surface === 'transparent') {
      throw new Error(
        'Transparent materials cannot cast ordinary depth shadows (gltf-render.transparent-shadow-unsupported).'
      );
    }
    const { device } = this.options.graphics;
    const buffers = [
      uniformBuffer(device, Array.from(input.transform.matrix)),
      uniformBuffer(device, Array.from(input.viewProjection)),
      uniformBuffer(device, shadowMaterialUniform(this.options.material.material))
    ];
    const bindGroups: RHIBindGroup[] = [];
    try {
      bindGroups.push(
        device.createBindGroup({
          layout: this.shadowBindGroupLayouts[0]!,
          entries: [{ binding: 0, resource: { buffer: buffers[0]! } }]
        }),
        device.createBindGroup({
          layout: this.shadowBindGroupLayouts[1]!,
          entries: [{ binding: 0, resource: { buffer: buffers[1]! } }]
        }),
        device.createBindGroup({
          layout: this.shadowBindGroupLayouts[2]!,
          entries: [
            { binding: 0, resource: { buffer: buffers[2]! } },
            { binding: 1, resource: this.materialTextures.views[0]! },
            { binding: 2, resource: this.materialTextures.sampler }
          ]
        })
      );
    } catch (error) {
      disposeResources([...bindGroups, ...buffers]);
      throw error;
    }
    return this.packet(input.entity, buffers, bindGroups, {
      pipeline: this.shadowPipeline,
      phase: 'shadow',
      pipelineKey: `${STANDARD_SHADOW_SHADER_MODULE_KEY}:${input.cascade}`,
      drawKey: `${input.entity}:shadow:${input.cascade}`
    });
  }

  /** Groups spot/point caster packets into a submission-scoped local shadow frame. */
  createLocalShadowFrame(input: {
    requests: readonly ShadowRequest[];
    packetsByRequestKey: ReadonlyMap<string, readonly PreparedDrawPacket[]>;
    receiverRecords: readonly LocalShadowReceiverRecord[];
  }): BaselineLocalShadowFrame {
    this.assertLive();
    const shadowUniformBuffer = uniformBuffer(
      this.options.graphics.device,
      packLocalShadowReceiverUniform(input.receiverRecords)
    );
    let released = false;
    let retained = false;
    return Object.freeze({
      requests: Object.freeze([...input.requests]),
      packetsByRequestKey: new ReadonlyMapSnapshot(input.packetsByRequestKey),
      uniformBuffer: shadowUniformBuffer,
      release: () => {
        if (released) return;
        released = true;
        if (!retained) {
          shadowUniformBuffer.dispose();
          for (const packets of input.packetsByRequestKey.values())
            for (const packet of packets) packet.release();
        }
      },
      retain: (submission: RHISubmission) => {
        if (released || retained)
          throw new Error('Baseline local shadow frame cannot be retained.');
        retained = true;
        const pending = submission.done.finally(() => {
          shadowUniformBuffer.dispose();
          for (const packets of input.packetsByRequestKey.values())
            for (const packet of packets) packet.release();
          this.pendingSubmissions.delete(pending);
        });
        this.pendingSubmissions.add(pending);
      }
    });
  }

  /** Uploads receiver CSM data and binds its lifetime to the frame submission. */
  createDirectionalShadowFrame(input: {
    requests: BaselineDirectionalShadowFrame['requests'];
    packetsByRequestKey: BaselineDirectionalShadowFrame['packetsByRequestKey'];
    view: ExtractedView;
    cascades: readonly { readonly splitFar: number; readonly viewProjection: readonly number[] }[];
    lightIndex: number;
    constantBias?: number;
    slopeBias?: number;
    pcfKernel?: 3 | 5;
  }): BaselineDirectionalShadowFrame {
    this.assertLive();
    if (input.cascades.length !== 4) {
      throw new Error('Baseline directional shadows require exactly four cascades.');
    }
    const floats = new Float32Array([
      ...input.cascades.flatMap((cascade) => [...cascade.viewProjection]),
      ...Array.from(input.view.view),
      ...input.cascades.map((cascade) => cascade.splitFar),
      1,
      input.constantBias ?? 0.0005,
      input.slopeBias ?? 0.002,
      1 / input.requests[0]!.resolutionClass,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0
    ]);
    const words = new Uint32Array(floats.buffer);
    words[88] = input.lightIndex;
    words[89] = ((input.pcfKernel ?? 3) - 1) / 2;
    const shadowUniformBuffer = uniformBuffer(this.options.graphics.device, words);
    let released = false;
    let retained = false;
    return Object.freeze({
      requests: input.requests,
      packetsByRequestKey: input.packetsByRequestKey,
      uniformBuffer: shadowUniformBuffer,
      release: () => {
        if (released) return;
        released = true;
        if (!retained) {
          shadowUniformBuffer.dispose();
          for (const packets of input.packetsByRequestKey.values()) {
            for (const packet of packets) packet.release();
          }
        }
      },
      retain: (submission: RHISubmission) => {
        if (released || retained) throw new Error('Baseline shadow frame cannot be retained.');
        retained = true;
        const pending = submission.done.finally(() => {
          shadowUniformBuffer.dispose();
          this.pendingSubmissions.delete(pending);
        });
        this.pendingSubmissions.add(pending);
      }
    });
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

  get disabledShadowReceiver(): Readonly<{
    buffer: RHIBuffer;
    localBuffer: RHIBuffer;
    map: RHITexture;
  }> {
    return Object.freeze({
      buffer: this.disabledShadowBuffer,
      localBuffer: this.disabledLocalShadowBuffer,
      map: this.disabledShadowTexture
    });
  }

  /** Updates the active environment intensity without rebuilding GPU pipelines or unmounting. */
  setEnvironmentIntensity(intensity: number): void {
    this.assertLive();
    if (!Number.isFinite(intensity) || intensity < 0) {
      throw new RangeError('Environment intensity must be a non-negative finite number.');
    }
    this.environmentIntensity = intensity;
    const { device } = this.options.graphics;
    // Word index 3 is float offset 3 = byte offset 12 in EnvironmentData uniform buffer layout
    device.queue.writeBuffer(this.environmentBuffer, 12, new Float32Array([intensity]));
  }

  /** Prepares background resources for the given view and background configuration. */
  createBackgroundFrame(
    view: ExtractedView,
    background?: ViewBackground
  ): PreparedBackgroundFrame | undefined {
    const bg = background ?? this.options.background;
    if (bg === undefined || bg.kind === 'none') return undefined;
    const { device } = this.options.graphics;
    const environmentIntensity = this.environmentIntensity;
    return prepareBackground({
      device,
      view,
      background: bg,
      colorFormat: 'rgba16float',
      depthFormat: 'depth24plus',
      sampleCount: this.sampleCount,
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
    /** A prepared per-view grid opts the WebGPU forward path into cluster assignment. */
    clusterGrid?: ClusterGrid;
  }): BaselineLightListFrame {
    this.assertLive();
    const { device } = this.options.graphics;
    const lightListDecision = this.featurePolicy.snapshot.decisions.get(
      BuiltInFeature.LightListBuild
    );
    if (
      input.clusterGrid !== undefined &&
      this.options.graphics.backend === 'webgpu' &&
      this.clusterLightListRecorder !== undefined
    ) {
      const packedLights = packWebGpuClusterLights(input);
      const packedGrid = packClusterGridForWebGpu(input.clusterGrid, this.clusterCapacity);
      const packedMetadata = packClusterForwardMetadata(input.clusterGrid);
      const upload = (label: string, words: Uint32Array, usage: number) => {
        const buffer = device.createBuffer({ label, size: Math.max(16, words.byteLength), usage });
        device.queue.writeBuffer(buffer, 0, words);
        return buffer;
      };
      // WGSL uses fixed-size uniform arrays for portable WebGPU/WebGL-style reflection; pad
      // variable uploads to the reflected minimum binding sizes rather than binding a short view.
      const lightWords = new Uint32Array(
        LIGHT_LIST_HEADER_WORDS + LIGHT_LIST_SHADER_MAX_LIGHTS * LIGHT_LIST_LIGHT_WORDS
      );
      lightWords.set(packedLights.words);
      const metadataWords = new Uint32Array(
        CLUSTER_FORWARD_HEADER_WORDS + CLUSTER_FORWARD_MAX_SLICES * CLUSTER_FORWARD_SLICE_WORDS
      );
      metadataWords.set(packedMetadata.words);
      return this.ownedClusterLightListFrame({
        source: 'gpu-cluster',
        lights: upload(
          'aether-cluster-packed-lights',
          lightWords,
          STORAGE_UNIFORM_UPLOAD_BUFFER_USAGE
        ),
        clusters: upload('aether-cluster-grid', packedGrid.words, STORAGE_UPLOAD_BUFFER_USAGE),
        metadata: upload(
          'aether-cluster-forward-metadata',
          metadataWords,
          STORAGE_UNIFORM_UPLOAD_BUFFER_USAGE
        ),
        grid: input.clusterGrid,
        capacity: this.clusterCapacity,
        recorder: this.clusterLightListRecorder,
        forwardBindGroupLayoutToken: this.clusterLightListBindGroupLayoutToken,
        forwardBindGroupLayout: this.clusterBindGroupLayouts?.[3] ?? this.lightListBindGroupLayout
      });
    }
    if (lightListDecision?.implementation === BuiltInFeatureImplementation.WebGpuComputeLightList) {
      const packed = packWebGpuLightListInput({ ...input, capacity: this.lightListCapacity });
      const lightWords = new Uint32Array(4 + LIGHT_LIST_SHADER_MAX_LIGHTS * LIGHT_LIST_LIGHT_WORDS);
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
        implementation: this.lightListImplementation as RenderFeatureImplementation<
          CpuLightListCapacity,
          WebGpuLightListBuildContext
        >,
        capacity: this.lightListCapacity,
        recorder: this.lightListRecorder as PreparedWebGpuLightListRecorder,
        forwardBindGroupLayoutToken: this.lightListBindGroupLayoutToken,
        forwardBindGroupLayout: this.lightListBindGroupLayout
      });
    }
    if (lightListDecision?.implementation === BuiltInFeatureImplementation.WebGlFragmentLightList) {
      const maxTextureDimension2D = device.capabilities.limits.maxTextureDimension2D;
      if (maxTextureDimension2D === undefined)
        throw new Error('WebGL2 LightList requires maxTextureDimension2D.');
      const packed = packWebGlLightListInput({
        ...input,
        capacity: this.lightListCapacity,
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
        implementation: this.lightListImplementation as RenderFeatureImplementation<
          CpuLightListCapacity,
          WebGlFragmentLightListBuildContext
        >,
        capacity: this.lightListCapacity,
        recorder: this.lightListRecorder as PreparedWebGlLightListRecorder,
        forwardBindGroupLayoutToken: this.lightListBindGroupLayoutToken,
        forwardBindGroupLayout: this.lightListBindGroupLayout
      });
    }

    // CPU bounded fallback: execute CPU culling and directly upload forward resources
    const cpuImpl = this.lightListImplementation as RuntimeFeatureImplementation<
      CpuLightListCapacity,
      CpuBoundedLightListFrameInput,
      CpuLightListResult
    >;
    const cpuResult = cpuImpl.execute(this.lightListCapacity, {
      viewLayerMask: input.viewLayerMask,
      lights: input.lights,
      receivers: input.receivers
    });

    if (this.options.graphics.backend === 'webgpu') {
      const packedWords = packCpuLightListForWebGpu(input, this.lightListCapacity, cpuResult);
      const buffers = uploadCpuLightListWebGpu(device, packedWords);

      return this.ownedCpuLightListFrame({
        source: 'cpu-list',
        backendTarget: 'webgpu',
        lights: buffers.lights,
        directional: buffers.directional,
        headers: buffers.headers,
        indices: buffers.indices,
        overflow: buffers.overflow,
        capacity: this.lightListCapacity,
        forwardBindGroupLayoutToken: this.lightListBindGroupLayoutToken,
        forwardBindGroupLayout: this.lightListBindGroupLayout
      });
    }

    // WebGL2 CPU bounded fallback: pack texels directly into RGBA32Uint textures
    const maxTextureDimension2D = device.capabilities.limits.maxTextureDimension2D ?? 2048;
    const packedTexels = packCpuLightListForWebGl(
      input,
      this.lightListCapacity,
      maxTextureDimension2D,
      cpuResult
    );
    const textures = uploadCpuLightListWebGl(device, packedTexels);

    return this.ownedCpuLightListFrame({
      source: 'cpu-list',
      backendTarget: 'webgl2',
      lights: textures.lights,
      directional: textures.directional,
      headers: textures.headers,
      indices: textures.indices,
      overflow: textures.overflow,
      capacity: this.lightListCapacity,
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
    this.clusterPipeline?.dispose();
    this.shadowPipeline.dispose();
    this.lightListRecorder?.dispose();
    this.clusterLightListRecorder?.dispose();
    this.environmentBuffer.dispose();
    this.materialTextures.dispose();
    this.disabledShadowBuffer.dispose();
    this.disabledLocalShadowBuffer.dispose();
    this.disabledShadowTexture.dispose();
    if (this.environmentBundle !== undefined) {
      this.environmentBundle.release();
    } else {
      disposeResources([
        this.environmentTextures.irradianceMap,
        this.environmentTextures.prefilteredRadianceMap
      ]);
    }
    disposeResources(this.postColorOwnedResources);
    this.defaultColorBuffer.dispose();
    this.shaderModule.dispose();
    this.clusterShaderModule?.dispose();
    this.shadowShaderModule.dispose();
    this.pipelineLayout.dispose();
    this.clusterPipelineLayout?.dispose();
    this.shadowPipelineLayout.dispose();
    disposeResources(this.bindGroupLayouts);
    if (this.clusterBindGroupLayouts !== undefined) disposeResources(this.clusterBindGroupLayouts);
    disposeResources(this.shadowBindGroupLayouts);
  }

  private packet(
    entity: RenderEntityId,
    buffers: readonly RHIBuffer[],
    bindGroups: readonly RHIBindGroup[],
    overrides?: Readonly<{
      pipeline: RHIRenderPipeline;
      phase: PreparedDrawPacket['phase'];
      pipelineKey: string;
      drawKey: string;
      bindingLayoutHash?: string;
    }>
  ): PreparedDrawPacket {
    const submesh = this.mesh.submeshes[0]!;
    let released = false;
    let retained = false;
    const bindingKey = createBindingKey({
      bindingLayoutHash: overrides?.bindingLayoutHash ?? this.bindingLayoutHash,
      resources: [],
      bufferAllocationGeneration: ++this.frameAllocationGeneration,
      ringGeneration: 1,
      dynamicOffsets: [],
      deviceGeneration: this.options.graphics.device.generation
    });
    const releaseFrameResources = (): void => disposeResources([...bindGroups, ...buffers]);
    return Object.freeze({
      entity,
      phase:
        overrides?.phase ??
        (this.options.material.material.asset.renderState.surface === 'transparent'
          ? 'transparent'
          : this.options.material.material.asset.renderState.surface === 'alpha-mask'
            ? 'alpha-test'
            : 'opaque'),
      pipelineKey: overrides?.pipelineKey ?? this.pipelineKey,
      materialKey: this.options.material.handle.assetId,
      meshKey: this.options.mesh.handle.assetId,
      bindingKey: bindingKey.hash,
      drawKey: overrides?.drawKey ?? `${entity}:0`,
      distance: 0,
      insertionOrder: 0,
      pipeline: overrides?.pipeline ?? this.pipeline,
      bindingSet: Object.freeze({
        bindingKey,
        bindGroups: Object.freeze([...bindGroups]),
        dynamicOffsetsByGroup: Object.freeze(bindGroups.map(() => EMPTY_DYNAMIC_OFFSETS)),
        deviceGeneration: this.options.graphics.device.generation
      }),
      vertexBuffers: this.hasColor0
        ? this.mesh.vertexBuffers
        : Object.freeze([...this.mesh.vertexBuffers, this.defaultColorBuffer]),
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

  /** Releases submission-held resources when the device loses context. */
  invalidateDevice(): void {
    for (const pending of this.pendingSubmissions) void pending;
    this.pendingSubmissions.clear();
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('Baseline standard-lit preparation is disposed.');
  }

  private ownedLightListFrame(frame: {
    source: 'gpu-compute' | 'webgl-fragment';
    lights: RHIBuffer | RHITexture;
    receivers: RHIBuffer | RHITexture;
    receiverCount?: number;
    maxTextureDimension2D?: number;
    implementation: BaselineLightListImplementation;
    capacity: CpuLightListCapacity;
    recorder: PreparedWebGpuLightListRecorder | PreparedWebGlLightListRecorder;
    forwardBindGroupLayoutToken: PreparedBindGroupLayoutToken;
    forwardBindGroupLayout: RHIBindGroupLayout;
  }): BaselineLightListFrame {
    let released = false;
    let retained = false;
    return Object.freeze({
      ...frame,
      release: () => {
        if (released) return;
        released = true;
        if (!retained) disposeResources([frame.lights, frame.receivers]);
      },
      retain: (submission: RHISubmission) => {
        if (released || retained) throw new Error('Baseline LightList frame cannot be retained.');
        retained = true;
        const pending = submission.done.finally(() => {
          disposeResources([frame.lights, frame.receivers]);
          this.pendingSubmissions.delete(pending);
        });
        this.pendingSubmissions.add(pending);
      }
    }) as BaselineLightListFrame;
  }

  private ownedClusterLightListFrame(frame: {
    source: 'gpu-cluster';
    lights: RHIBuffer;
    clusters: RHIBuffer;
    metadata: RHIBuffer;
    grid: ClusterGrid;
    capacity: ClusterCapacity;
    recorder: PreparedWebGpuClusterLightListRecorder;
    forwardBindGroupLayoutToken: PreparedBindGroupLayoutToken;
    forwardBindGroupLayout: RHIBindGroupLayout;
  }): BaselineLightListFrame {
    let released = false;
    let retained = false;
    const resources = [frame.lights, frame.clusters, frame.metadata];
    return Object.freeze({
      ...frame,
      release: () => {
        if (released) return;
        released = true;
        if (!retained) disposeResources(resources);
      },
      retain: (submission: RHISubmission) => {
        if (released || retained)
          throw new Error('Baseline cluster LightList frame cannot be retained.');
        retained = true;
        const pending = submission.done.finally(() => {
          disposeResources(resources);
          this.pendingSubmissions.delete(pending);
        });
        this.pendingSubmissions.add(pending);
      }
    });
  }

  private ownedCpuLightListFrame(frame: {
    source: 'cpu-list';
    backendTarget: 'webgpu' | 'webgl2';
    lights: RHIBuffer | RHITexture;
    directional: RHIBuffer | RHITexture;
    headers: RHIBuffer | RHITexture;
    indices: RHIBuffer | RHITexture;
    overflow: RHIBuffer | RHITexture;
    capacity: CpuLightListCapacity;
    forwardBindGroupLayoutToken: PreparedBindGroupLayoutToken;
    forwardBindGroupLayout: RHIBindGroupLayout;
  }): BaselineLightListFrame {
    let released = false;
    let retained = false;
    const resources = [
      frame.lights,
      frame.directional,
      frame.headers,
      frame.indices,
      frame.overflow
    ];
    return Object.freeze({
      ...frame,
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

function standardLitShaderLocation(semantic: string): number {
  switch (semantic) {
    case 'POSITION':
      return 0;
    case 'NORMAL':
      return 1;
    case 'TEXCOORD_0':
      return 2;
    case 'TEXCOORD_1':
      return 3;
    case 'TANGENT':
      return 4;
    case 'COLOR_0':
      return 5;
    default:
      throw new Error(`Standard-lit mesh semantic "${semantic}" is unsupported.`);
  }
}
