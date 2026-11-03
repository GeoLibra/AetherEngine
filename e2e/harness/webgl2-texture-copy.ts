import { WebGL2ContextControlExtension, type BrowserGraphicsSession } from '../../src';

const BUFFER_COPY_SRC = 1 << 2;
const BUFFER_COPY_DST = 1 << 3;
const TEXTURE_COPY_SRC = 1 << 0;
const TEXTURE_COPY_DST = 1 << 1;
const COPY_ROW_BYTES = 256;
const PIXEL = new Uint8Array([29, 71, 157, 255]);
const INTEGER_PIXEL = new Uint32Array([0x12345678, 0x89abcdef, 0x13579bdf, 0x2468ace0]);
const HALF_FLOAT_PIXEL = new Uint16Array([0x3c00, 0x3800, 0x3400, 0x3c00]);
const FLOAT_PIXEL = new Float32Array([0.125, -2.5, 3.75, 1]);
const SINGLE_CHANNEL_PIXEL = new Uint8Array([203]);
const TWO_CHANNEL_PIXEL = new Uint8Array([37, 211]);

export interface WebGL2TextureCopyGolden {
  readonly matchesTexture: boolean;
  readonly matchesBuffer: boolean;
  readonly integerMatches: boolean;
  readonly halfFloatMatches: boolean;
  readonly floatMatches: boolean;
  readonly singleChannelMatches: boolean;
  readonly twoChannelMatches: boolean;
  readonly bytes: readonly number[];
}

/** Verifies public WebGL2 RHI buffer-texture copies with native texture and PBO inspection. */
export async function runWebGL2TextureCopyGolden(
  session: BrowserGraphicsSession,
  gl: WebGL2RenderingContext
): Promise<WebGL2TextureCopyGolden> {
  const created = captureNativeResources(gl, () => {
    const source = session.device.createBuffer({
      label: 'e2e-copy-source',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_SRC | BUFFER_COPY_DST
    });
    const readback = session.device.createBuffer({
      label: 'e2e-copy-readback',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_DST
    });
    const texture = session.device.createTexture({
      label: 'e2e-copy-texture',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    const copiedTexture = session.device.createTexture({
      label: 'e2e-copy-target',
      size: [1, 1],
      format: 'rgba8unorm',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    return { source, readback, texture, copiedTexture };
  });
  const control = session.device.getExtension(WebGL2ContextControlExtension);
  try {
    session.device.queue.writeBuffer(created.value.source, 0, PIXEL);
    const encoder = session.device.createCommandEncoder({ label: 'e2e-buffer-texture-copy' });
    encoder.copyBufferToTexture(
      { buffer: created.value.source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture: created.value.texture },
      [1, 1]
    );
    encoder.copyTextureToTexture(
      { texture: created.value.texture },
      { texture: created.value.copiedTexture },
      [1, 1]
    );
    encoder.copyTextureToBuffer(
      { texture: created.value.copiedTexture },
      { buffer: created.value.readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed') {
      throw new Error(`WebGL2 texture-copy submission ended with ${submission.status}.`);
    }
    const textureBytes = readTexture(gl, created.textures[1]!);
    const bufferBytes = readBuffer(gl, created.buffers[1]!);
    const matchesTexture = equalBytes(textureBytes, PIXEL);
    const matchesBuffer = equalBytes(bufferBytes, PIXEL);
    if (!matchesTexture || !matchesBuffer) {
      throw new Error(
        `WebGL2 texture-copy readback mismatch: texture ${textureBytes}, buffer ${bufferBytes}.`
      );
    }
    if (gl.getError() !== gl.NO_ERROR) throw new Error('WebGL2 texture-copy produced a GL error.');
    const integerMatches = await runIntegerTextureCopyGolden(session, gl);
    const halfFloatMatches = await runHalfFloatTextureCopyGolden(session, gl);
    const floatMatches = await runFloatTextureCopyGolden(session, gl);
    const singleChannelMatches = await runSingleChannelTextureCopyGolden(session, gl);
    const twoChannelMatches = await runTwoChannelTextureCopyGolden(session, gl);
    return Object.freeze({
      matchesTexture,
      matchesBuffer,
      integerMatches,
      halfFloatMatches,
      floatMatches,
      singleChannelMatches,
      twoChannelMatches,
      bytes: Object.freeze(Array.from(bufferBytes))
    });
  } finally {
    // Test-only native inspection changes bindings outside the replay cache.
    control?.invalidateExternalState();
    created.value.copiedTexture.dispose();
    created.value.texture.dispose();
    created.value.readback.dispose();
    created.value.source.dispose();
  }
}

async function runTwoChannelTextureCopyGolden(
  session: BrowserGraphicsSession,
  gl: WebGL2RenderingContext
): Promise<boolean> {
  const created = captureNativeResources(gl, () => {
    const source = session.device.createBuffer({
      label: 'e2e-rg8-copy-source',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_SRC | BUFFER_COPY_DST
    });
    const readback = session.device.createBuffer({
      label: 'e2e-rg8-copy-readback',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_DST
    });
    const texture = session.device.createTexture({
      label: 'e2e-rg8-copy-texture',
      size: [1, 1],
      format: 'rg8unorm',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    const copiedTexture = session.device.createTexture({
      label: 'e2e-rg8-copy-target',
      size: [1, 1],
      format: 'rg8unorm',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    return { source, readback, texture, copiedTexture };
  });
  try {
    session.device.queue.writeBuffer(created.value.source, 0, TWO_CHANNEL_PIXEL);
    const encoder = session.device.createCommandEncoder({ label: 'e2e-rg8-buffer-texture-copy' });
    encoder.copyBufferToTexture(
      { buffer: created.value.source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture: created.value.texture },
      [1, 1]
    );
    encoder.copyTextureToTexture(
      { texture: created.value.texture },
      { texture: created.value.copiedTexture },
      [1, 1]
    );
    encoder.copyTextureToBuffer(
      { texture: created.value.copiedTexture },
      { buffer: created.value.readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed')
      throw new Error(`WebGL2 RG8 texture-copy submission ended with ${submission.status}.`);
    const textureBytes = readTwoChannelTexture(gl, created.textures[1]!);
    const bufferBytes = readTwoChannelBuffer(gl, created.buffers[1]!);
    const matches =
      equalBytes(textureBytes, TWO_CHANNEL_PIXEL) && equalBytes(bufferBytes, TWO_CHANNEL_PIXEL);
    if (!matches) throw new Error('WebGL2 RG8 texture-copy readback mismatch.');
    return true;
  } finally {
    session.device.getExtension(WebGL2ContextControlExtension)?.invalidateExternalState();
    created.value.copiedTexture.dispose();
    created.value.texture.dispose();
    created.value.readback.dispose();
    created.value.source.dispose();
  }
}

async function runSingleChannelTextureCopyGolden(
  session: BrowserGraphicsSession,
  gl: WebGL2RenderingContext
): Promise<boolean> {
  const created = captureNativeResources(gl, () => {
    const source = session.device.createBuffer({
      label: 'e2e-r8-copy-source',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_SRC | BUFFER_COPY_DST
    });
    const readback = session.device.createBuffer({
      label: 'e2e-r8-copy-readback',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_DST
    });
    const texture = session.device.createTexture({
      label: 'e2e-r8-copy-texture',
      size: [1, 1],
      format: 'r8unorm',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    const copiedTexture = session.device.createTexture({
      label: 'e2e-r8-copy-target',
      size: [1, 1],
      format: 'r8unorm',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    return { source, readback, texture, copiedTexture };
  });
  try {
    session.device.queue.writeBuffer(created.value.source, 0, SINGLE_CHANNEL_PIXEL);
    const encoder = session.device.createCommandEncoder({ label: 'e2e-r8-buffer-texture-copy' });
    encoder.copyBufferToTexture(
      { buffer: created.value.source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture: created.value.texture },
      [1, 1]
    );
    encoder.copyTextureToTexture(
      { texture: created.value.texture },
      { texture: created.value.copiedTexture },
      [1, 1]
    );
    encoder.copyTextureToBuffer(
      { texture: created.value.copiedTexture },
      { buffer: created.value.readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed') {
      throw new Error(`WebGL2 R8 texture-copy submission ended with ${submission.status}.`);
    }
    const textureBytes = readSingleChannelTexture(gl, created.textures[1]!);
    const bufferBytes = readSingleChannelBuffer(gl, created.buffers[1]!);
    const matches =
      equalBytes(textureBytes, SINGLE_CHANNEL_PIXEL) &&
      equalBytes(bufferBytes, SINGLE_CHANNEL_PIXEL);
    if (!matches) throw new Error('WebGL2 R8 texture-copy readback mismatch.');
    return true;
  } finally {
    session.device.getExtension(WebGL2ContextControlExtension)?.invalidateExternalState();
    created.value.copiedTexture.dispose();
    created.value.texture.dispose();
    created.value.readback.dispose();
    created.value.source.dispose();
  }
}

async function runFloatTextureCopyGolden(
  session: BrowserGraphicsSession,
  gl: WebGL2RenderingContext
): Promise<boolean> {
  const created = captureNativeResources(gl, () => {
    const source = session.device.createBuffer({
      label: 'e2e-float-copy-source',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_SRC | BUFFER_COPY_DST
    });
    const readback = session.device.createBuffer({
      label: 'e2e-float-copy-readback',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_DST
    });
    const texture = session.device.createTexture({
      label: 'e2e-float-copy-texture',
      size: [1, 1],
      format: 'rgba32float',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    const copiedTexture = session.device.createTexture({
      label: 'e2e-float-copy-target',
      size: [1, 1],
      format: 'rgba32float',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    return { source, readback, texture, copiedTexture };
  });
  try {
    session.device.queue.writeBuffer(created.value.source, 0, FLOAT_PIXEL);
    const encoder = session.device.createCommandEncoder({ label: 'e2e-float-buffer-texture-copy' });
    encoder.copyBufferToTexture(
      { buffer: created.value.source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture: created.value.texture },
      [1, 1]
    );
    encoder.copyTextureToTexture(
      { texture: created.value.texture },
      { texture: created.value.copiedTexture },
      [1, 1]
    );
    encoder.copyTextureToBuffer(
      { texture: created.value.copiedTexture },
      { buffer: created.value.readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed') {
      throw new Error(`WebGL2 float texture-copy submission ended with ${submission.status}.`);
    }
    const textureValues = readFloatTexture(gl, created.textures[1]!);
    const bufferValues = readFloatBuffer(gl, created.buffers[1]!);
    const matches =
      equalFloatValues(textureValues, FLOAT_PIXEL) && equalFloatValues(bufferValues, FLOAT_PIXEL);
    if (!matches) throw new Error('WebGL2 float texture-copy readback mismatch.');
    return true;
  } finally {
    session.device.getExtension(WebGL2ContextControlExtension)?.invalidateExternalState();
    created.value.copiedTexture.dispose();
    created.value.texture.dispose();
    created.value.readback.dispose();
    created.value.source.dispose();
  }
}

async function runHalfFloatTextureCopyGolden(
  session: BrowserGraphicsSession,
  gl: WebGL2RenderingContext
): Promise<boolean> {
  const created = captureNativeResources(gl, () => {
    const source = session.device.createBuffer({
      label: 'e2e-half-float-copy-source',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_SRC | BUFFER_COPY_DST
    });
    const readback = session.device.createBuffer({
      label: 'e2e-half-float-copy-readback',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_DST
    });
    const texture = session.device.createTexture({
      label: 'e2e-half-float-copy-texture',
      size: [1, 1],
      format: 'rgba16float',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    const copiedTexture = session.device.createTexture({
      label: 'e2e-half-float-copy-target',
      size: [1, 1],
      format: 'rgba16float',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    return { source, readback, texture, copiedTexture };
  });
  try {
    session.device.queue.writeBuffer(created.value.source, 0, HALF_FLOAT_PIXEL);
    const encoder = session.device.createCommandEncoder({
      label: 'e2e-half-float-buffer-texture-copy'
    });
    encoder.copyBufferToTexture(
      { buffer: created.value.source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture: created.value.texture },
      [1, 1]
    );
    encoder.copyTextureToTexture(
      { texture: created.value.texture },
      { texture: created.value.copiedTexture },
      [1, 1]
    );
    encoder.copyTextureToBuffer(
      { texture: created.value.copiedTexture },
      { buffer: created.value.readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed') {
      throw new Error(`WebGL2 half-float texture-copy submission ended with ${submission.status}.`);
    }
    const textureWords = readHalfFloatTexture(gl, created.textures[1]!);
    const bufferWords = readHalfFloatBuffer(gl, created.buffers[1]!);
    const matches =
      equalHalfWords(textureWords, HALF_FLOAT_PIXEL) &&
      equalHalfWords(bufferWords, HALF_FLOAT_PIXEL);
    if (!matches) throw new Error('WebGL2 half-float texture-copy readback mismatch.');
    return true;
  } finally {
    session.device.getExtension(WebGL2ContextControlExtension)?.invalidateExternalState();
    created.value.copiedTexture.dispose();
    created.value.texture.dispose();
    created.value.readback.dispose();
    created.value.source.dispose();
  }
}

async function runIntegerTextureCopyGolden(
  session: BrowserGraphicsSession,
  gl: WebGL2RenderingContext
): Promise<boolean> {
  const created = captureNativeResources(gl, () => {
    const source = session.device.createBuffer({
      label: 'e2e-integer-copy-source',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_SRC | BUFFER_COPY_DST
    });
    const readback = session.device.createBuffer({
      label: 'e2e-integer-copy-readback',
      size: COPY_ROW_BYTES,
      usage: BUFFER_COPY_DST
    });
    const texture = session.device.createTexture({
      label: 'e2e-integer-copy-texture',
      size: [1, 1],
      format: 'rgba32uint',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    const copiedTexture = session.device.createTexture({
      label: 'e2e-integer-copy-target',
      size: [1, 1],
      format: 'rgba32uint',
      usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
    });
    return { source, readback, texture, copiedTexture };
  });
  try {
    session.device.queue.writeBuffer(created.value.source, 0, INTEGER_PIXEL);
    const encoder = session.device.createCommandEncoder({
      label: 'e2e-integer-buffer-texture-copy'
    });
    encoder.copyBufferToTexture(
      { buffer: created.value.source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture: created.value.texture },
      [1, 1]
    );
    encoder.copyTextureToTexture(
      { texture: created.value.texture },
      { texture: created.value.copiedTexture },
      [1, 1]
    );
    encoder.copyTextureToBuffer(
      { texture: created.value.copiedTexture },
      { buffer: created.value.readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed') {
      throw new Error(`WebGL2 integer texture-copy submission ended with ${submission.status}.`);
    }
    const textureWords = readIntegerTexture(gl, created.textures[1]!);
    const bufferWords = readIntegerBuffer(gl, created.buffers[1]!);
    const matches =
      equalWords(textureWords, INTEGER_PIXEL) && equalWords(bufferWords, INTEGER_PIXEL);
    if (!matches) throw new Error('WebGL2 integer texture-copy readback mismatch.');
    return true;
  } finally {
    session.device.getExtension(WebGL2ContextControlExtension)?.invalidateExternalState();
    created.value.copiedTexture.dispose();
    created.value.texture.dispose();
    created.value.readback.dispose();
    created.value.source.dispose();
  }
}

function captureNativeResources<T>(gl: WebGL2RenderingContext, create: () => T) {
  const originalBuffer = gl.createBuffer.bind(gl);
  const originalTexture = gl.createTexture.bind(gl);
  const buffers: WebGLBuffer[] = [];
  const textures: WebGLTexture[] = [];
  gl.createBuffer = () => {
    const handle = originalBuffer();
    if (handle !== null) buffers.push(handle);
    return handle;
  };
  gl.createTexture = () => {
    const handle = originalTexture();
    if (handle !== null) textures.push(handle);
    return handle;
  };
  try {
    return { value: create(), buffers: Object.freeze(buffers), textures: Object.freeze(textures) };
  } finally {
    gl.createBuffer = originalBuffer;
    gl.createTexture = originalTexture;
  }
}

function readTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): Uint8Array {
  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null) throw new Error('WebGL2 texture-copy could not create a framebuffer.');
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const bytes = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  } finally {
    gl.deleteFramebuffer(framebuffer);
  }
}

function readBuffer(gl: WebGL2RenderingContext, buffer: WebGLBuffer): Uint8Array {
  const bytes = new Uint8Array(4);
  gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, bytes);
  return bytes;
}

function readSingleChannelTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): Uint8Array {
  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null)
    throw new Error('WebGL2 R8 texture-copy could not create a framebuffer.');
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const bytes = new Uint8Array(1);
    gl.readPixels(0, 0, 1, 1, gl.RED, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  } finally {
    gl.deleteFramebuffer(framebuffer);
  }
}

function readSingleChannelBuffer(gl: WebGL2RenderingContext, buffer: WebGLBuffer): Uint8Array {
  const bytes = new Uint8Array(1);
  gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, bytes);
  return bytes;
}

function readTwoChannelTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): Uint8Array {
  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null)
    throw new Error('WebGL2 RG8 texture-copy could not create a framebuffer.');
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const bytes = new Uint8Array(2);
    gl.readPixels(0, 0, 1, 1, gl.RG, gl.UNSIGNED_BYTE, bytes);
    return bytes;
  } finally {
    gl.deleteFramebuffer(framebuffer);
  }
}

function readTwoChannelBuffer(gl: WebGL2RenderingContext, buffer: WebGLBuffer): Uint8Array {
  const bytes = new Uint8Array(2);
  gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, bytes);
  return bytes;
}

function readIntegerTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): Uint32Array {
  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null)
    throw new Error('WebGL2 integer texture-copy could not create a framebuffer.');
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const words = new Uint32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA_INTEGER, gl.UNSIGNED_INT, words);
    return words;
  } finally {
    gl.deleteFramebuffer(framebuffer);
  }
}

function readIntegerBuffer(gl: WebGL2RenderingContext, buffer: WebGLBuffer): Uint32Array {
  const words = new Uint32Array(4);
  gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, words);
  return words;
}

function readHalfFloatTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): Uint16Array {
  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null)
    throw new Error('WebGL2 half-float texture-copy could not create a framebuffer.');
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const words = new Uint16Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.HALF_FLOAT, words);
    return words;
  } finally {
    gl.deleteFramebuffer(framebuffer);
  }
}

function readHalfFloatBuffer(gl: WebGL2RenderingContext, buffer: WebGLBuffer): Uint16Array {
  const words = new Uint16Array(4);
  gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, words);
  return words;
}

function readFloatTexture(gl: WebGL2RenderingContext, texture: WebGLTexture): Float32Array {
  const framebuffer = gl.createFramebuffer();
  if (framebuffer === null)
    throw new Error('WebGL2 float texture-copy could not create a framebuffer.');
  try {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const values = new Float32Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, values);
    return values;
  } finally {
    gl.deleteFramebuffer(framebuffer);
  }
}

function readFloatBuffer(gl: WebGL2RenderingContext, buffer: WebGLBuffer): Float32Array {
  const values = new Float32Array(4);
  gl.bindBuffer(gl.COPY_READ_BUFFER, buffer);
  gl.getBufferSubData(gl.COPY_READ_BUFFER, 0, values);
  return values;
}

function equalBytes(actual: Uint8Array, expected: Uint8Array): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function equalWords(actual: Uint32Array, expected: Uint32Array): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function equalHalfWords(actual: Uint16Array, expected: Uint16Array): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function equalFloatValues(actual: Float32Array, expected: Float32Array): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}
