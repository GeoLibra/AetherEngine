import {
  buildCpuLightLists,
  calculateWebGlLightListPacking,
  decodeWebGlLightListOutput,
  packWebGlLightListInput,
  prepareWebGlLightListRecorder,
  type BrowserGraphicsSession,
  type LightReceiver,
  type PreparedLight,
  type RenderEntityId
} from '../../src';

const capacity = Object.freeze({
  maxDirectionalLights: 1,
  maxLightsPerReceiver: 2,
  maxLightIndices: 3
});

export interface WebGlLightListGolden {
  readonly matchesCpuOracle: boolean;
  readonly directionalIndices: readonly number[];
  readonly headerCount: number;
  readonly lightIndexCount: number;
  readonly overflowed: boolean;
}

/** Runs the cooked integer-MRT kernel and reads its native WebGL2 attachments. */
export async function runWebGlLightListGolden(
  session: BrowserGraphicsSession,
  gl: WebGL2RenderingContext
): Promise<WebGlLightListGolden> {
  const fixture = createFixture();
  const cpu = buildCpuLightLists({ ...fixture, capacity });
  const maxTextureDimension2D = session.device.capabilities.limits.maxTextureDimension2D;
  if (maxTextureDimension2D === undefined)
    throw new Error('WebGL2 did not publish maxTextureDimension2D.');
  const packed = packWebGlLightListInput({
    ...fixture,
    capacity,
    maxTextureDimension2D
  });
  const packing = calculateWebGlLightListPacking(
    fixture.receivers.length,
    capacity,
    maxTextureDimension2D
  );
  const nativeTextures = captureIntegerTextures(gl, () => [
    session.device.createTexture({
      size: [packed.width, packed.lightsHeight],
      format: 'rgba32uint',
      usage: 0x06
    }),
    session.device.createTexture({
      size: [packed.width, packed.receiversHeight],
      format: 'rgba32uint',
      usage: 0x06
    }),
    ...Array.from({ length: 4 }, () =>
      session.device.createTexture({
        size: [packing.width, packing.height],
        format: 'rgba32uint',
        usage: 0x11
      })
    )
  ]);
  const resources = nativeTextures.resources;
  const prepared = prepareWebGlLightListRecorder(session.device);
  try {
    session.device.queue.writeTexture(
      { texture: resources[0]! },
      packed.lights,
      { bytesPerRow: packed.width * 16, rowsPerImage: packed.lightsHeight },
      [packed.width, packed.lightsHeight]
    );
    session.device.queue.writeTexture(
      { texture: resources[1]! },
      packed.receivers,
      { bytesPerRow: packed.width * 16, rowsPerImage: packed.receiversHeight },
      [packed.width, packed.receiversHeight]
    );
    const group = session.device.createBindGroup({
      layout: prepared.bindGroupLayout,
      entries: [
        { binding: 0, resource: resources[0]!.createView() },
        { binding: 1, resource: resources[1]!.createView() }
      ]
    });
    try {
      const encoder = session.device.createCommandEncoder({ label: 'webgl2-light-list-golden' });
      const pass = encoder.beginRenderPass({
        colorAttachments: resources.slice(2).map((texture) => ({
          view: texture.createView(),
          loadOp: 'clear' as const,
          storeOp: 'store' as const,
          clearValue: { r: 0, g: 0, b: 0, a: 0 }
        }))
      });
      pass.setPipeline(prepared.pipeline);
      pass.setBindGroup(0, group);
      pass.setViewport(0, 0, packing.width, packing.height, 0, 1);
      pass.draw(3);
      pass.end();
      const submission = session.device.queue.submit([encoder.finish()]);
      const completion = await submission.done;
      if (completion.status !== 'completed')
        throw new Error(`WebGL2 LightList submission ended with ${completion.status}.`);
      const outputs = nativeTextures.native
        .slice(2)
        .map((texture) => readIntegerTexture(gl, texture, packing.width, packing.height));
      const decoded = decodeWebGlLightListOutput({
        receiverCount: fixture.receivers.length,
        capacity,
        width: packing.width,
        directional: outputs[0]!,
        headers: outputs[1]!,
        indices: outputs[2]!,
        overflow: outputs[3]!
      });
      const expectedHeaders = cpu.headers.map(({ receiver, offset, count, overflowed }) => ({
        receiver,
        offset,
        count,
        overflowed
      }));
      if (
        JSON.stringify(decoded.directionalIndices) !==
          JSON.stringify(cpu.globalDirectionalLightIndices) ||
        JSON.stringify(decoded.headers) !== JSON.stringify(expectedHeaders) ||
        JSON.stringify(decoded.lightIndices) !== JSON.stringify(cpu.lightIndices) ||
        decoded.overflowed !== cpu.overflowed
      )
        throw new Error(`WebGL2 LightList mismatch: ${JSON.stringify({ cpu, decoded })}`);
      return Object.freeze({
        matchesCpuOracle: true,
        directionalIndices: decoded.directionalIndices,
        headerCount: decoded.headers.length,
        lightIndexCount: decoded.lightIndices.length,
        overflowed: decoded.overflowed
      });
    } finally {
      group.dispose();
    }
  } finally {
    prepared.dispose();
    for (const resource of resources) resource.dispose();
  }
}

function captureIntegerTextures<
  T extends readonly ReturnType<BrowserGraphicsSession['device']['createTexture']>[]
>(
  gl: WebGL2RenderingContext,
  create: () => T
): { readonly resources: T; readonly native: readonly WebGLTexture[] } {
  const originalBind = gl.bindTexture.bind(gl);
  const originalStorage = gl.texStorage2D.bind(gl);
  const native: WebGLTexture[] = [];
  let current: WebGLTexture | null = null;
  Object.defineProperty(gl, 'bindTexture', {
    configurable: true,
    value(target: number, texture: WebGLTexture | null) {
      if (target === gl.TEXTURE_2D) current = texture;
      return originalBind(target, texture);
    }
  });
  Object.defineProperty(gl, 'texStorage2D', {
    configurable: true,
    value(target: number, levels: number, internalFormat: number, width: number, height: number) {
      if (internalFormat === gl.RGBA32UI && current !== null) native.push(current);
      return originalStorage(target, levels, internalFormat, width, height);
    }
  });
  try {
    const resources = create();
    if (native.length !== resources.length)
      throw new Error('Failed to capture WebGL2 integer texture allocations.');
    return { resources, native: Object.freeze([...native]) };
  } finally {
    Object.defineProperty(gl, 'bindTexture', { configurable: true, value: originalBind });
    Object.defineProperty(gl, 'texStorage2D', { configurable: true, value: originalStorage });
  }
}

function readIntegerTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number
): Uint32Array {
  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null)
    throw new Error('Failed to create WebGL2 LightList readback framebuffer.');
  const words = new Uint32Array(width * height * 4);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.READ_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.readBuffer(gl.COLOR_ATTACHMENT0);
  gl.readPixels(0, 0, width, height, gl.RGBA_INTEGER, gl.UNSIGNED_INT, words);
  gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
  gl.deleteFramebuffer(framebuffer);
  const error = gl.getError();
  if (error !== gl.NO_ERROR)
    throw new Error(`WebGL2 LightList readback failed with 0x${error.toString(16)}.`);
  return words;
}

function createFixture(): {
  readonly viewLayerMask: number;
  readonly lights: readonly PreparedLight[];
  readonly receivers: readonly LightReceiver[];
} {
  const entity = (value: number) => value as RenderEntityId;
  return {
    viewLayerMask: 1,
    lights: [
      ...[1, 2].map((value) => ({
        entity: entity(value),
        payloadVersion: 1,
        kind: 'directional' as const,
        direction: [0, -1, 0] as const,
        illuminanceLux: 10,
        colorLinear: [1, 1, 1] as const,
        enabled: true,
        layerMask: 1,
        castsShadow: false
      })),
      ...[3, 4, 5].map((value) => ({
        entity: entity(value),
        payloadVersion: 1,
        kind: 'point' as const,
        position: [0, 0, 0] as const,
        luminousIntensityCandela: 1,
        range: 5,
        colorLinear: [1, 1, 1] as const,
        enabled: true,
        layerMask: 1,
        castsShadow: false
      }))
    ],
    receivers: [10, 11].map((value) => ({
      renderEntity: entity(value),
      layerMask: 1,
      bounds: { kind: 'sphere' as const, center: [0, 0, 0] as const, radius: 1 }
    }))
  };
}
