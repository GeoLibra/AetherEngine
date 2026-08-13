import {
  RenderGraphBuilder,
  RenderGraphExecutor,
  compileRenderGraph,
  createBrowserGraphics,
  createRenderGraphExecutionPlan,
  type BrowserGraphicsSession,
  type RestrictedPassContext
} from '../../src';

const WIDTH = 640;
const HEIGHT = 360;
const INDEX_DATA = new Uint16Array([
  0, 1, 2, 2, 1, 3,
  4, 6, 5, 5, 6, 7,
  0, 2, 4, 4, 2, 6,
  1, 5, 3, 3, 5, 7,
  2, 3, 6, 6, 3, 7,
  0, 4, 1, 1, 4, 5
]);

export interface WebGPUSceneResult {
  readonly detail: Readonly<Record<string, unknown>>;
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

  try {
    const execution = executeScene(session, indexBuffer);
    await execution.submission.done;
    const fastPath = fastPathMetrics(session.device);
    const diagnostics = diagnosticMessages(session);
    return Object.freeze({
      detail: Object.freeze({
        generation: session.device.generation,
        surfaceGeneration: session.surface.generation,
        renderPasses: execution.commandStats.renderPasses,
        drawCalls: execution.commandStats.draw.drawCalls,
        indexedDrawCalls: execution.commandStats.draw.indexedDrawCalls,
        nativeQueueSubmits: fastPath.nativeQueueSubmits,
        validationErrors: diagnostics.length,
        diagnostics
      }),
      async destroy(): Promise<void> {
        indexBuffer.dispose();
        await session.destroy();
      }
    });
  } catch (error) {
    indexBuffer.dispose();
    await session.destroy();
    throw error;
  }
}

function executeScene(session: BrowserGraphicsSession, indexBuffer: ReturnType<BrowserGraphicsSession['device']['createBuffer']>) {
  const configuration = session.surface.configuration;
  if (configuration === undefined) throw new Error('WebGPU surface is not configured.');
  const graph = new RenderGraphBuilder();
  const surfaceToken = { kind: 'surface-frame' as const, id: 'webgpu-main' };
  const surfaceColor = graph.createTexture({
    width: configuration.width,
    height: configuration.height,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format: configuration.format,
    usage: ['color-attachment']
  }, {
    origin: {
      kind: 'imported',
      initialState: 'undefined',
      acquire: { kind: 'external-acquire', id: surfaceToken.id }
    }
  });
  const depth = graph.createTexture({
    width: configuration.width,
    height: configuration.height,
    depthOrArrayLayers: 1,
    mipLevelCount: 1,
    sampleCount: 1,
    format: 'depth24plus',
    usage: ['depth-stencil-attachment']
  });
  const indices = graph.createBuffer({ size: INDEX_DATA.byteLength, usage: ['index', 'copy-dst'] }, {
    origin: {
      kind: 'imported',
      initialState: 'index',
      acquire: { kind: 'external-acquire', id: 'cube-indices' }
    }
  });
  graph.addPass({
    id: 'clear-triangle-indexed-cube',
    setup(pass) {
      const color = pass.writeTexture(surfaceColor, 'color-attachment');
      const depthAttachment = pass.writeTexture(depth, 'depth-stencil-attachment');
      const index = pass.readBuffer(indices, 'index');
      pass.presentTexture(color, surfaceToken);
      return { color, depthAttachment, index };
    },
    run(context: RestrictedPassContext, resources) {
      recordScene(context, resources, configuration.format);
    }
  });
  const snapshot = graph.build();
  const plan = createRenderGraphExecutionPlan(snapshot, compileRenderGraph(snapshot));
  return new RenderGraphExecutor().execute(plan, {
    device: session.device,
    surface: session.surface,
    resources: new Map([[indices, indexBuffer]])
  });
}

function recordScene(
  context: RestrictedPassContext,
  resources: { readonly color: Parameters<RestrictedPassContext['texture']>[0]; readonly depthAttachment: Parameters<RestrictedPassContext['texture']>[0]; readonly index: Parameters<RestrictedPassContext['buffer']>[0] },
  format: string
): void {
  const emptyLayout = context.device.createBindGroupLayout({ entries: [] });
  const pipelineLayout = context.device.createPipelineLayout({ bindGroupLayouts: [emptyLayout] });
  const triangleShader = context.device.createShaderModule({ code: TRIANGLE_SHADER });
  const cubeShader = context.device.createShaderModule({ code: CUBE_SHADER });
  const trianglePipeline = context.device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module: triangleShader, entryPoint: 'vs_main' },
    fragment: { module: triangleShader, entryPoint: 'fs_main', targets: [{ format }] },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' }
  });
  const cubePipeline = context.device.createRenderPipeline({
    layout: pipelineLayout,
    vertex: { module: cubeShader, entryPoint: 'vs_main' },
    fragment: { module: cubeShader, entryPoint: 'fs_main', targets: [{ format }] },
    primitive: { cullMode: 'back', frontFace: 'ccw' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
  });
  const index = context.buffer(resources.index, 'index');
  const pass = context.beginRaster({
    label: 'webgpu-conformance-scene',
    colorAttachments: [{
      texture: resources.color,
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0.025, g: 0.04, b: 0.08, a: 1 }
    }],
    depthStencilAttachment: {
      texture: resources.depthAttachment,
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      depthClearValue: 1
    }
  });
  pass.setPipeline(trianglePipeline);
  pass.draw(3);
  pass.setPipeline(cubePipeline);
  pass.setIndexBuffer(index, 'uint16');
  pass.drawIndexed(INDEX_DATA.length);
  pass.end();
}

function fastPathMetrics(device: BrowserGraphicsSession['device']): { readonly nativeQueueSubmits: number } {
  const metrics = Reflect.get(device, 'fastPathMetrics');
  if (typeof metrics !== 'function') throw new Error('WebGPU fast-path metrics are unavailable.');
  return Reflect.apply(metrics, device, []) as { readonly nativeQueueSubmits: number };
}

function diagnosticMessages(session: BrowserGraphicsSession): readonly string[] {
  const diagnostics = Reflect.get(session.adapter, 'diagnostics');
  if (typeof diagnostics !== 'object' || diagnostics === null) return [];
  const list = Reflect.get(diagnostics, 'list');
  if (typeof list !== 'function') return [];
  return (Reflect.apply(list, diagnostics, []) as readonly unknown[]).map((entry) => {
    if (typeof entry !== 'object' || entry === null) return String(entry);
    const message = Reflect.get(entry, 'message');
    return typeof message === 'string' ? message : String(entry);
  });
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
