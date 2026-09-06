import {
  BrowserGraphicsBootstrapError,
  createBrowserGraphics,
  type RenderEntityId,
  type RenderView,
  type WebGL2ShaderTranslationPort
} from '../../src';
import { createE2EDrawPacket, executeOpaqueScene } from './opaque-scene';

const TRIANGLE_INDEX_COUNT = 3;
const CUBE_INDEX_COUNT = 6;
const INDICES = new Uint16Array([0, 1, 2, 0, 1, 2, 2, 1, 3, 0]);

export async function runWebGL2Scene(canvas: HTMLCanvasElement) {
  const session = await createSession(canvas);
  const gl = canvas.getContext('webgl2');
  const presentProbe = gl === null ? undefined : instrumentGL(gl);
  const glErrors: number[] = [gl?.getError() ?? -1];
  const index = session.device.createBuffer({ size: INDICES.byteLength, usage: 0x18 });
  session.device.queue.writeBuffer(index, 0, INDICES);
  const uniform = session.device.createBuffer({ size: 16, usage: 0x40 });
  session.device.queue.writeBuffer(uniform, 0, new Float32Array([1, 1, 1, 1]));
  const red = session.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x06 });
  const green = session.device.createTexture({ size: [1, 1], format: 'rgba8unorm', usage: 0x06 });
  session.device.queue.writeTexture(
    { texture: red },
    new Uint8Array([255, 0, 0, 255]),
    { bytesPerRow: 4, rowsPerImage: 1 },
    [1, 1]
  );
  glErrors.push(gl?.getError() ?? -1);
  session.device.queue.writeTexture(
    { texture: green },
    new Uint8Array([0, 255, 0, 255]),
    { bytesPerRow: 4, rowsPerImage: 1 },
    [1, 1]
  );
  const linear = session.device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const nearest = session.device.createSampler({ magFilter: 'nearest', minFilter: 'nearest' });
  const groupLayout = session.device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: 1, buffer: { type: 'uniform' } },
      { binding: 1, visibility: 2, texture: { sampleType: 'float' } },
      { binding: 2, visibility: 2, sampler: { type: 'filtering' } },
      { binding: 3, visibility: 2, texture: { sampleType: 'float' } },
      { binding: 4, visibility: 2, sampler: { type: 'non-filtering' } }
    ]
  });
  const group = session.device.createBindGroup({
    layout: groupLayout,
    entries: [
      { binding: 0, resource: { buffer: uniform, offset: 0, size: 16 } },
      { binding: 1, resource: red.createView() },
      { binding: 2, resource: linear },
      { binding: 3, resource: green.createView() },
      { binding: 4, resource: nearest }
    ]
  });
  const emptyLayout = session.device.createPipelineLayout({ bindGroupLayouts: [] });
  const boundLayout = session.device.createPipelineLayout({ bindGroupLayouts: [groupLayout] });
  const triangleModule = session.device.createShaderModule({ code: 'triangle' });
  const cubeModule = session.device.createShaderModule({ code: 'cube' });
  const triangle = session.device.createRenderPipeline({
    layout: emptyLayout,
    vertex: { module: triangleModule },
    fragment: { module: triangleModule, targets: [{ format: 'rgba8unorm' }] },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' }
  });
  const cube = session.device.createRenderPipeline({
    layout: boundLayout,
    vertex: { module: cubeModule },
    fragment: { module: cubeModule, targets: [{ format: 'rgba8unorm' }] },
    primitive: { cullMode: 'back', frontFace: 'ccw' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
  });
  glErrors.push(gl?.getError() ?? -1);
  const render = (width: number, height: number) =>
    executeOpaqueScene({
      device: session.device,
      surface: session.surface,
      view: sceneView(width, height),
      surfaceFrame: { kind: 'surface-frame', id: 'webgl2-main' },
      width,
      height,
      colorFormat: 'rgba8unorm',
      packets: [
        createE2EDrawPacket({
          entity: 1 as RenderEntityId,
          drawKey: 'triangle',
          pipeline: triangle,
          indexBuffer: index,
          indexFormat: 'uint16',
          indexCount: TRIANGLE_INDEX_COUNT,
          retain: () => undefined,
          release: () => undefined
        }),
        createE2EDrawPacket({
          entity: 2 as RenderEntityId,
          drawKey: 'cube',
          pipeline: cube,
          bindGroups: [group],
          indexBuffer: index,
          indexFormat: 'uint16',
          firstIndex: TRIANGLE_INDEX_COUNT,
          indexCount: CUBE_INDEX_COUNT,
          retain: () => undefined,
          release: () => undefined
        })
      ]
    });
  const execution = render(640, 360);
  glErrors.push(gl?.getError() ?? -1);
  await execution.execution.submission.done;
  const centerPixel = presentProbe?.beforePresentPixel ?? new Uint8Array(4);
  const presentedPixel = presentProbe?.afterPresentPixel ?? new Uint8Array(4);
  glErrors.push(gl?.getError() ?? -1);
  const buildDetail = (
    rendered: boolean,
    commandStats = execution.execution.commandStats
  ): Readonly<Record<string, unknown>> => {
    const currentMetrics = Reflect.apply(
      Reflect.get(session.device.queue, 'metrics'),
      session.device.queue,
      []
    ) as unknown as Readonly<Record<string, number>>;
    return Object.freeze({
      generation: session.device.generation,
      surfaceGeneration: session.surface.generation,
      format: session.surface.configuration?.format,
      renderPath: execution.renderPath,
      renderSystemInstances: execution.renderSystemInstances,
      rendered,
      renderPasses: commandStats.renderPasses,
      drawCalls: commandStats.draw.drawCalls,
      indexedDrawCalls: commandStats.draw.indexedDrawCalls,
      nativeQueueSubmits: currentMetrics.submissionEpochs,
      glCalls: currentMetrics.glCalls,
      glErrors: Object.freeze([...glErrors]),
      centerPixel: [...centerPixel],
      presentedPixel: [...presentedPixel]
    });
  };
  return Object.freeze({
    detail: buildDetail(true),
    async resize(width: number, height: number): Promise<Readonly<Record<string, unknown>>> {
      session.resize({ width, height });
      presentProbe?.setExtent(width, height);
      glErrors.push(gl?.getError() ?? -1);
      if (width === 0 || height === 0) return buildDetail(false);
      const resized = render(width, height);
      await resized.execution.submission.done;
      glErrors.push(gl?.getError() ?? -1);
      return buildDetail(true, resized.execution.commandStats);
    },
    async destroy(): Promise<void> {
      cube.dispose();
      triangle.dispose();
      cubeModule.dispose();
      triangleModule.dispose();
      boundLayout.dispose();
      emptyLayout.dispose();
      group.dispose();
      groupLayout.dispose();
      nearest.dispose();
      linear.dispose();
      green.dispose();
      red.dispose();
      uniform.dispose();
      index.dispose();
      await session.destroy();
    }
  });
}

interface WebGL2PresentProbe {
  readonly beforePresentPixel: Uint8Array;
  readonly afterPresentPixel: Uint8Array;
  setExtent(width: number, height: number): void;
}

function instrumentGL(gl: WebGL2RenderingContext): WebGL2PresentProbe {
  const beforePresentPixel = new Uint8Array(4);
  const afterPresentPixel = new Uint8Array(4);
  let width = 640;
  let height = 360;
  for (const name of [
    'bindFramebuffer',
    'framebufferTexture2D',
    'clearBufferfv',
    'useProgram',
    'bindVertexArray',
    'enable',
    'disable',
    'depthMask',
    'depthFunc',
    'viewport',
    'scissor',
    'drawArraysInstanced',
    'drawElementsInstanced',
    'blitFramebuffer'
  ] as const) {
    const original = gl[name] as (...args: unknown[]) => unknown;
    Object.defineProperty(gl, name, {
      configurable: true,
      value: (...args: unknown[]) => {
        if (name === 'blitFramebuffer') {
          gl.readPixels(
            Math.floor(width / 2),
            Math.max(0, Math.floor(height / 2) - 1),
            1,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            beforePresentPixel
          );
        }
        const result = Reflect.apply(original, gl, args);
        if (name === 'blitFramebuffer') {
          const source = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
          gl.readPixels(
            Math.floor(width / 2),
            Math.floor(height / 2),
            1,
            1,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            afterPresentPixel
          );
          gl.bindFramebuffer(gl.READ_FRAMEBUFFER, source);
        }
        const error = gl.getError();
        if (error !== gl.NO_ERROR)
          throw new Error(`WebGL2 ${name} failed with 0x${error.toString(16)}.`);
        return result;
      }
    });
  }
  return Object.freeze({
    beforePresentPixel,
    afterPresentPixel,
    setExtent(nextWidth: number, nextHeight: number): void {
      width = nextWidth;
      height = nextHeight;
    }
  });
}

function sceneView(width: number, height: number): RenderView {
  return Object.freeze({
    id: 'webgl2-main',
    camera: 1 as RenderEntityId,
    surface: 'webgl2-main',
    viewport: Object.freeze({ x: 0, y: 0, width, height }),
    layerMask: 1,
    featurePolicyKey: 'webgl2-baseline',
    historyKey: 'webgl2-main'
  });
}

async function createSession(canvas: HTMLCanvasElement) {
  try {
    return await createBrowserGraphics({
      canvas,
      preference: ['webgl2'],
      powerPreference: 'high-performance',
      device: { requiredFeatures: [], optionalFeatures: [] },
      surface: { width: 640, height: 360, format: 'rgba8unorm', alphaMode: 'opaque' },
      webgl2Translator: TRANSLATOR,
      webgl2ClipControl: false
    });
  } catch (error) {
    if (error instanceof BrowserGraphicsBootstrapError) {
      throw new Error(
        error.attempts
          .map((attempt) => `${attempt.backend}/${attempt.stage}: ${attempt.message}`)
          .join('; ')
      );
    }
    throw error;
  }
}

const TRANSLATOR: WebGL2ShaderTranslationPort = {
  translatorId: 'aether-e2e-glsl',
  version: 1,
  translate(input) {
    const source =
      input.stage === 'vertex'
        ? input.wgsl === 'triangle'
          ? TRIANGLE_VERTEX
          : CUBE_VERTEX
        : input.wgsl === 'triangle'
          ? TRIANGLE_FRAGMENT
          : CUBE_FRAGMENT;
    const cubeBindings =
      input.wgsl !== 'cube'
        ? []
        : input.stage === 'vertex'
          ? [{ group: 0, binding: 0, name: 'Aether_0_0', kind: 'uniform-buffer' as const }]
          : [
              { group: 0, binding: 1, name: 'redTexture', kind: 'texture' as const },
              { group: 0, binding: 2, name: 'linearSampler', kind: 'sampler' as const },
              { group: 0, binding: 3, name: 'greenTexture', kind: 'texture' as const },
              { group: 0, binding: 4, name: 'nearestSampler', kind: 'sampler' as const }
            ];
    const cubePhysicalBindings = cubeBindings.map((binding) => ({
      group: binding.group,
      binding: binding.binding,
      kind: binding.kind,
      slot: binding.kind === 'uniform-buffer' || binding.binding <= 2 ? 0 : 1
    }));
    return {
      source,
      bindings: cubeBindings,
      targetAbiFingerprint: 'e2e-glsl-v1',
      physicalBindings: cubePhysicalBindings,
      programBindings:
        input.wgsl !== 'cube'
          ? []
          : input.stage === 'vertex'
            ? [{ kind: 'uniform-buffer', name: 'Aether_0_0', slot: 0 }]
            : [
                { kind: 'combined-sampler', name: 'aether_t0_1_s0_2', slot: 0 },
                { kind: 'combined-sampler', name: 'aether_t0_3_s0_4', slot: 1 }
              ],
      requiredExtensions: [],
      sourceMap: [],
      translatorFingerprint: `${input.wgsl}-${input.stage}`
    };
  }
};

const TRIANGLE_VERTEX = `
out vec3 v_color;
void main() {
  vec2 p[3] = vec2[3](vec2(-0.9,0.75), vec2(0.0,-0.9), vec2(0.9,0.75));
  vec3 c[3] = vec3[3](vec3(1.0,0.15,0.12), vec3(0.1,1.0,0.35), vec3(0.1,0.35,1.0));
  gl_Position = vec4(p[gl_VertexID], 0.85, 1.0); v_color = c[gl_VertexID];
}`;
const TRIANGLE_FRAGMENT = `precision highp float; in vec3 v_color; out vec4 out_color;
void main() { out_color = vec4(v_color * 0.32, 1.0); }`;
const CUBE_VERTEX = `
out vec3 v_color;
layout(std140) uniform Aether_0_0 { vec4 tint; };
void main() {
  vec2 p[4] = vec2[4](vec2(-0.48,0.48),vec2(0.48,0.48),vec2(-0.48,-0.48),vec2(0.48,-0.48));
  vec2 q = p[gl_VertexID]; gl_Position = vec4(q, 0.35, 1.0);
  v_color = vec3(vec2(q.x, -q.y) * 0.5 + 0.5, 0.9) * tint.rgb;
}`;
const CUBE_FRAGMENT = `precision highp float; in vec3 v_color; out vec4 out_color;
uniform sampler2D aether_t0_1_s0_2;
uniform sampler2D aether_t0_3_s0_4;
void main() {
  float bindingProof = (texture(aether_t0_1_s0_2, vec2(0.5)).r +
    texture(aether_t0_3_s0_4, vec2(0.5)).g) * 0.5;
  out_color = vec4(v_color * bindingProof, 1.0);
}`;
