import {
  BrowserGraphicsBootstrapError,
  createBrowserGraphics,
  type WebGL2ShaderTranslationPort
} from '../../src';

const INDICES = new Uint16Array([0, 1, 2, 2, 1, 3]);

export async function runWebGL2Scene(canvas: HTMLCanvasElement) {
  const session = await createSession(canvas);
  const gl = canvas.getContext('webgl2');
  if (gl !== null) instrumentGL(gl);
  const glErrors: number[] = [gl?.getError() ?? -1];
  const acquired = session.surface.acquire();
  glErrors.push(gl?.getError() ?? -1);
  if (acquired.status !== 'success')
    throw new Error(`WebGL2 surface acquire failed: ${acquired.status}.`);
  const encoder = session.device.createCommandEncoder({ label: 'webgl2-browser-e2e' });
  const view = acquired.frame.texture.createView();
  const depth = session.device.createTexture({
    size: [640, 360],
    format: 'depth24plus',
    usage: 0x10
  });
  const index = session.device.createBuffer({ size: INDICES.byteLength, usage: 0x18 });
  session.device.queue.writeBuffer(index, 0, INDICES);
  const layout = session.device.createPipelineLayout({ bindGroupLayouts: [] });
  const triangleModule = session.device.createShaderModule({ code: 'triangle' });
  const cubeModule = session.device.createShaderModule({ code: 'cube' });
  const triangle = session.device.createRenderPipeline({
    layout,
    vertex: { module: triangleModule },
    fragment: { module: triangleModule, targets: [{ format: 'rgba8unorm' }] },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'always' }
  });
  const cube = session.device.createRenderPipeline({
    layout,
    vertex: { module: cubeModule },
    fragment: { module: cubeModule, targets: [{ format: 'rgba8unorm' }] },
    primitive: { cullMode: 'back', frontFace: 'ccw' },
    depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' }
  });
  glErrors.push(gl?.getError() ?? -1);
  const pass = encoder.beginRenderPass({
    label: 'webgl2-clear',
    colorAttachments: [
      { view, loadOp: 'clear', storeOp: 'store', clearValue: { r: 0.04, g: 0.12, b: 0.24, a: 1 } }
    ],
    depthStencilAttachment: {
      view: depth.createView(),
      depthLoadOp: 'clear',
      depthStoreOp: 'store',
      depthClearValue: 1
    }
  });
  pass.setViewport(24, 16, 592, 328, 0, 1);
  pass.setScissorRect(24, 16, 592, 328);
  pass.setPipeline(triangle);
  pass.draw(3);
  pass.setPipeline(cube);
  pass.setIndexBuffer(index, 'uint16');
  pass.drawIndexed(INDICES.length);
  pass.end();
  const command = encoder.finish();
  const submission = session.device.queue.submit([command]);
  await submission.done;
  glErrors.push(gl?.getError() ?? -1);
  const centerPixel = new Uint8Array(4);
  gl?.readPixels(320, 180, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, centerPixel);
  acquired.frame.present();
  glErrors.push(gl?.getError() ?? -1);
  const presentedPixel = new Uint8Array(4);
  gl?.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl?.readPixels(320, 180, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, presentedPixel);
  const metrics = Reflect.apply(
    Reflect.get(session.device.queue, 'metrics'),
    session.device.queue,
    []
  ) as unknown as Readonly<Record<string, number>>;
  return Object.freeze({
    detail: Object.freeze({
      generation: session.device.generation,
      surfaceGeneration: session.surface.generation,
      format: session.surface.configuration?.format,
      renderPasses: command.getStats().renderPasses,
      drawCalls: command.getStats().draw.drawCalls,
      indexedDrawCalls: command.getStats().draw.indexedDrawCalls,
      nativeQueueSubmits: metrics.submissionEpochs,
      glCalls: metrics.glCalls,
      glErrors,
      centerPixel: [...centerPixel],
      presentedPixel: [...presentedPixel]
    }),
    async destroy(): Promise<void> {
      view.dispose();
      command.dispose();
      cube.dispose();
      triangle.dispose();
      cubeModule.dispose();
      triangleModule.dispose();
      layout.dispose();
      index.dispose();
      depth.dispose();
      await session.destroy();
    }
  });
}

function instrumentGL(gl: WebGL2RenderingContext): void {
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
        const result = Reflect.apply(original, gl, args);
        const error = gl.getError();
        if (error !== gl.NO_ERROR)
          throw new Error(`WebGL2 ${name} failed with 0x${error.toString(16)}.`);
        return result;
      }
    });
  }
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
    return {
      source,
      bindings: [],
      targetAbiFingerprint: 'e2e-glsl-v1',
      physicalBindings: [],
      requiredExtensions: [],
      sourceMap: [],
      translatorFingerprint: `${input.wgsl}-${input.stage}`
    };
  }
};

const TRIANGLE_VERTEX = `
out vec3 v_color;
void main() {
  vec2 p[3] = vec2[3](vec2(-0.9,-0.75), vec2(0.0,0.9), vec2(0.9,-0.75));
  vec3 c[3] = vec3[3](vec3(1.0,0.15,0.12), vec3(0.1,1.0,0.35), vec3(0.1,0.35,1.0));
  gl_Position = vec4(p[gl_VertexID], 0.85, 1.0); v_color = c[gl_VertexID];
}`;
const TRIANGLE_FRAGMENT = `precision highp float; in vec3 v_color; out vec4 out_color;
void main() { out_color = vec4(v_color * 0.32, 1.0); }`;
const CUBE_VERTEX = `
out vec3 v_color;
void main() {
  vec2 p[4] = vec2[4](vec2(-0.48,-0.48),vec2(0.48,-0.48),vec2(-0.48,0.48),vec2(0.48,0.48));
  vec2 q = p[gl_VertexID]; gl_Position = vec4(q, 0.35, 1.0);
  v_color = vec3(q * 0.5 + 0.5, 0.9);
}`;
const CUBE_FRAGMENT = `precision highp float; in vec3 v_color; out vec4 out_color;
void main() { out_color = vec4(v_color, 1.0); }`;
