import {
  STANDARD_LIT_SHADER_ABI_VERSION,
  STANDARD_LIT_SHADER_MODULE,
  createShaderBindingManifest,
  emitWgslModule
} from '../../shader';
import { StandardLitMaterialSchema } from '../../material';
import { STANDARD_LIT_SHADER_MODULE_KEY } from '../../material/builtins';
import type { RHIBindGroup, RHIBuffer, RHIResource, RHISubmission } from '../../rhi/contracts';
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
import type { ExtractedView } from '../camera';
import type { PreparedLight } from '../lighting';
import type { RenderEntityId } from '../world';
import type { RenderTransformFact } from '../mesh';
import type { BaselineRenderingOptions } from './types';

const UNIFORM_BUFFER_USAGE = (1 << 3) | (1 << 6);
const EMPTY_DYNAMIC_OFFSETS: readonly number[] = Object.freeze([]);

type RegisteredOptions = BaselineRenderingOptions &
  Required<Pick<BaselineRenderingOptions, 'mesh' | 'material' | 'featurePolicyKey'>>;

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
  private frameAllocationGeneration = 0;
  private disposed = false;

  constructor(private readonly options: RegisteredOptions) {
    const { device } = options.graphics;
    const manifest = createShaderBindingManifest(
      STANDARD_LIT_SHADER_MODULE,
      STANDARD_LIT_SHADER_ABI_VERSION
    );
    const compiled = compileBindingLayoutPlan(manifest);
    if (compiled.kind !== 'success') {
      throw new Error(`Standard-lit binding layout is invalid: ${compiled.diagnostic.message}`);
    }
    const target = options.graphics.backend;
    const entry = new LayoutCache().resolve({
      plan: compiled.plan,
      layoutRevision: STANDARD_LIT_SHADER_ABI_VERSION,
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
      code: emitWgslModule(STANDARD_LIT_SHADER_MODULE)
    });
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
        targets: [{ format: options.graphics.surface.configuration!.format }]
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
      shaderModuleKey: STANDARD_LIT_SHADER_MODULE_KEY,
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
      attachmentFormats: [options.graphics.surface.configuration!.format],
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
    light: PreparedLight;
  }): PreparedDrawPacket {
    this.assertLive();
    const { device } = this.options.graphics;
    const buffers = [
      uniformBuffer(device, objectUniform(input.transform)),
      uniformBuffer(device, viewUniform(input.view)),
      uniformBuffer(device, materialUniform(this.options.material.material)),
      uniformBuffer(device, lightUniform(input.light))
    ];
    const bindGroups: RHIBindGroup[] = [];
    try {
      for (let group = 0; group < this.bindGroupLayouts.length; group += 1) {
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

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await Promise.allSettled([...this.pendingSubmissions]);
    disposePreparedMesh(this.mesh);
    this.pipeline.dispose();
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
}

function uniformBuffer(
  device: RegisteredOptions['graphics']['device'],
  values: readonly number[]
): RHIBuffer {
  const byteLength = Math.max(16, Math.ceil(values.length / 4) * 16);
  const buffer = device.createBuffer({ size: byteLength, usage: UNIFORM_BUFFER_USAGE });
  device.queue.writeBuffer(buffer, 0, new Float32Array(values));
  return buffer;
}

function materialUniform(material: RegisteredOptions['material']['material']): readonly number[] {
  const baseColor = material.instance.parameters.get(StandardLitMaterialSchema.fields.baseColor);
  return [
    baseColor[0]!,
    baseColor[1]!,
    baseColor[2]!,
    baseColor[3]!,
    material.instance.parameters.get(StandardLitMaterialSchema.fields.metallic),
    material.instance.parameters.get(StandardLitMaterialSchema.fields.roughness),
    0,
    0
  ];
}

function objectUniform(transform: RenderTransformFact): readonly number[] {
  const normal = transform.normalMatrix;
  if (normal.length !== 9) throw new Error('Standard-lit normal matrix must contain nine values.');
  return [
    ...transform.matrix,
    normal[0]!,
    normal[1]!,
    normal[2]!,
    0,
    normal[3]!,
    normal[4]!,
    normal[5]!,
    0,
    normal[6]!,
    normal[7]!,
    normal[8]!,
    0,
    0,
    0,
    0,
    1
  ];
}

function viewUniform(view: ExtractedView): readonly number[] {
  return [
    ...Array.from(view.viewProjection),
    view.cameraPosition[0],
    view.cameraPosition[1],
    view.cameraPosition[2],
    0
  ];
}

function lightUniform(light: PreparedLight): readonly number[] {
  if (light.kind !== 'directional')
    throw new Error('Baseline standard-lit requires directional light.');
  return [
    light.direction[0],
    light.direction[1],
    light.direction[2],
    light.illuminanceLux,
    light.colorLinear[0],
    light.colorLinear[1],
    light.colorLinear[2],
    0
  ];
}

function disposeResources(resources: readonly RHIResource[]): void {
  for (const resource of [...resources].reverse()) resource.dispose();
}
