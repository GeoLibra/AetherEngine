import {
  createBrowserGraphics,
  type BrowserGraphicsSession,
  type RenderEntityId,
  type RenderView
} from '../../src';
import { createE2EDrawPacket, executeOpaqueScene } from './opaque-scene';
import { runWebGpuLightListGolden } from './webgpu-light-list';
import { runWebGpuClusterLightListGolden } from './webgpu-cluster-light-list';
import { runWebGpuTextureCopyGolden } from './webgpu-texture-copy';

const WIDTH = 640;
const HEIGHT = 360;
const TRIANGLE_INDEX_COUNT = 3;
const CUBE_INDEX_DATA = new Uint16Array([
  0, 1, 2, 2, 1, 3, 4, 6, 5, 5, 6, 7, 0, 2, 4, 4, 2, 6, 1, 5, 3, 3, 5, 7, 2, 3, 6, 6, 3, 7, 0, 4, 1,
  1, 4, 5
]);
const INDEX_DATA = new Uint16Array([0, 1, 2, ...CUBE_INDEX_DATA, 0]);

export interface WebGPUSceneResult {
  readonly detail: Readonly<Record<string, unknown>>;
  resize(width: number, height: number): Promise<Readonly<Record<string, unknown>>>;
  destroy(): Promise<void>;
}

export async function runWebGPUScene(canvas: HTMLCanvasElement): Promise<WebGPUSceneResult> {
  const session = await createBrowserGraphics({
    canvas,
    preference: ['webgpu'],
    powerPreference: 'high-performance',
    device: { requiredFeatures: [], optionalFeatures: [] },
    surface: { width: WIDTH, height: HEIGHT, alphaMode: 'opaque' }
  });
  const indexBuffer = session.device.createBuffer({
    label: 'cube-indices',
    size: INDEX_DATA.byteLength,
    usage: (1 << 4) | (1 << 3)
  });
  session.device.queue.writeBuffer(indexBuffer, 0, INDEX_DATA);
  const prepared = prepareScenePipelines(session);

  try {
    const lightListGolden = await runWebGpuLightListGolden(session);
    const clusterLightListGolden = await runWebGpuClusterLightListGolden(session);
    const textureCopyGolden = await runWebGpuTextureCopyGolden(session);
    const execution = executeScene(session, indexBuffer, prepared);
    await execution.execution.submission.done;
    const buildDetail = (
      rendered: boolean,
      commandStats = execution.execution.commandStats
    ): Readonly<Record<string, unknown>> => {
      const currentFastPath = fastPathMetrics(session.device);
      const currentDiagnostics = diagnosticMessages(session);
      return Object.freeze({
        adapterName: session.adapter.info.name,
        adapterVendor: session.adapter.info.vendor,
        adapterArchitecture: session.adapter.info.architecture,
        generation: session.device.generation,
        surfaceGeneration: session.surface.generation,
        format: session.surface.configuration?.format,
        colorSpace: session.surface.configuration?.colorSpace,
        alphaMode: session.surface.configuration?.alphaMode,
        renderPath: execution.renderPath,
        renderSystemInstances: execution.renderSystemInstances,
        rendered,
        renderPasses: commandStats.renderPasses,
        drawCalls: commandStats.draw.drawCalls,
        indexedDrawCalls: commandStats.draw.indexedDrawCalls,
        nativeQueueSubmits: currentFastPath.nativeQueueSubmits,
        validationErrors: currentDiagnostics.length,
        diagnostics: currentDiagnostics,
        lightListGolden,
        clusterLightListGolden,
        textureCopyGolden
      });
    };
    return Object.freeze({
      detail: buildDetail(true),
      async resize(width: number, height: number) {
        session.resize({ width, height });
        if (width === 0 || height === 0) return buildDetail(false);
        const resized = executeScene(session, indexBuffer, prepared);
        await resized.execution.submission.done;
        return buildDetail(true, resized.execution.commandStats);
      },
      async destroy(): Promise<void> {
        prepared.dispose();
        indexBuffer.dispose();
        await session.destroy();
      }
    });
  } catch (error) {
    prepared.dispose();
    indexBuffer.dispose();
    await session.destroy();
    throw error;
  }
}

function executeScene(
  session: BrowserGraphicsSession,
  indexBuffer: ReturnType<BrowserGraphicsSession['device']['createBuffer']>,
  prepared: ReturnType<typeof prepareScenePipelines>
) {
  const configuration = session.surface.configuration;
  if (configuration === undefined) throw new Error('WebGPU surface is not configured.');
  const surfaceToken = { kind: 'surface-frame' as const, id: 'webgpu-main' };
  const packets = [
    createE2EDrawPacket({
      entity: 1 as RenderEntityId,
      drawKey: 'triangle',
      pipeline: prepared.trianglePipeline,
      indexBuffer,
      indexFormat: 'uint16',
      indexCount: TRIANGLE_INDEX_COUNT,
      retain: () => undefined,
      release: () => undefined
    }),
    createE2EDrawPacket({
      entity: 2 as RenderEntityId,
      drawKey: 'cube',
      pipeline: prepared.cubePipeline,
      indexBuffer,
      indexFormat: 'uint16',
      firstIndex: TRIANGLE_INDEX_COUNT,
      indexCount: CUBE_INDEX_DATA.length,
      retain: () => undefined,
      release: () => undefined
    })
  ];
  return executeOpaqueScene({
    device: session.device,
    surface: session.surface,
    view: sceneView(configuration.width, configuration.height),
    surfaceFrame: surfaceToken,
    width: configuration.width,
    height: configuration.height,
    colorFormat: configuration.format,
    packets
  });
}

function sceneView(width: number, height: number): RenderView {
  return Object.freeze({
    id: 'webgpu-main',
    camera: 1 as RenderEntityId,
    surface: 'webgpu-main',
    viewport: Object.freeze({ x: 0, y: 0, width, height }),
    layerMask: 1,
    featurePolicyKey: 'webgpu-baseline',
    historyKey: 'webgpu-main'
  });
}

function prepareScenePipelines(session: BrowserGraphicsSession) {
  const format = session.surface.configuration?.format;
  if (format === undefined) throw new Error('WebGPU surface is not configured.');
  const emptyLayout = session.device.createBindGroupLayout({ entries: [] });
  const pipelineLayout = session.device.createPipelineLayout({ bindGroupLayouts: [emptyLayout] });
  const triangleShader = session.device.createShaderModule({ code: TRIANGLE_SHADER });
  const cubeShader = session.device.createShaderModule({ code: CUBE_SHADER });
  const trianglePipeline = session.device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module: triangleShader, entryPoint: 'vs_main' },
    fragment: { module: triangleShader, entryPoint: 'fs_main', targets: [{ format }] },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' }
  });
  const cubePipeline = session.device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module: cubeShader, entryPoint: 'vs_main' },
    fragment: { module: cubeShader, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { cullMode: 'back', frontFace: 'ccw' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
  });
  return Object.freeze({
    trianglePipeline,
    cubePipeline,
    dispose(): void {
      cubePipeline.dispose();
      trianglePipeline.dispose();
      cubeShader.dispose();
      triangleShader.dispose();
      pipelineLayout.dispose();
      emptyLayout.dispose();
    }
  });
}

function fastPathMetrics(device: BrowserGraphicsSession['device']): {
  readonly nativeQueueSubmits: number;
} {
  const metrics = Reflect.get(device, 'fastPathMetrics');
  if (typeof metrics !== 'function') throw new Error('WebGPU fast-path metrics are unavailable.');
  return Reflect.apply(metrics, device, []) as { readonly nativeQueueSubmits: number };
}

function diagnosticMessages(session: BrowserGraphicsSession): readonly string[] {
  const diagnostics = Reflect.get(session.adapter, 'diagnostics');
  if (typeof diagnostics !== 'object' || diagnostics === null) return [];
  const list = Reflect.get(diagnostics, 'list');
  if (typeof list !== 'function') return [];
  return Object.freeze(
    (Reflect.apply(list, diagnostics, []) as readonly unknown[]).map((entry) => {
      if (typeof entry !== 'object' || entry === null) return String(entry);
      const message = Reflect.get(entry, 'message');
      return typeof message === 'string' ? message : String(entry);
    })
  );
}

const TRIANGLE_SHADER = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec2f, 3>(vec2f(-0.9, -0.75), vec2f(0.0, 0.9), vec2f(0.9, -0.75));
  var colors = array<vec3f, 3>(vec3f(1.0, 0.15, 0.12), vec3f(0.1, 1.0, 0.35), vec3f(0.1, 0.35, 1.0));
  var output: VertexOutput;
  output.position = vec4f(positions[index], 0.85, 1.0);
  output.color = colors[index];
  return output;
}

@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color * 0.32, 1.0);
}`;

const CUBE_SHADER = `
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) color: vec3f,
}

@vertex fn vs_main(@builtin(vertex_index) index: u32) -> VertexOutput {
  var positions = array<vec3f, 8>(
    vec3f(-1.0, -1.0, -1.0), vec3f(1.0, -1.0, -1.0),
    vec3f(-1.0, 1.0, -1.0), vec3f(1.0, 1.0, -1.0),
    vec3f(-1.0, -1.0, 1.0), vec3f(1.0, -1.0, 1.0),
    vec3f(-1.0, 1.0, 1.0), vec3f(1.0, 1.0, 1.0)
  );
  let source = positions[index];
  let c = 0.819152;
  let s = 0.573576;
  let rotated = vec3f(source.x * c + source.z * s, source.y, -source.x * s + source.z * c);
  let z = rotated.z + 4.2;
  var output: VertexOutput;
  output.position = vec4f(rotated.x * 1.35, rotated.y * 1.35, z - 0.15, z);
  output.color = 0.35 + 0.65 * (source + vec3f(1.0)) * 0.5;
  return output;
}

@fragment fn fs_main(input: VertexOutput) -> @location(0) vec4f {
  return vec4f(input.color, 1.0);
}`;
