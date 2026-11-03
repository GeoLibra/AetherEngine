import type { BrowserGraphicsSession } from '../../src';

const COPY_SRC = 1 << 2;
const COPY_DST = 1 << 3;
const TEXTURE_COPY_SRC = 1 << 0;
const TEXTURE_COPY_DST = 1 << 1;
const MAP_READ = 1;
const COPY_ROW_BYTES = 256;
const PIXEL = new Uint8Array([17, 61, 143, 255]);
const INTEGER_PIXEL = new Uint32Array([0x12345678, 0x89abcdef, 0x13579bdf, 0x2468ace0]);
const HALF_FLOAT_PIXEL = new Uint16Array([0x3c00, 0x3800, 0x3400, 0x3c00]);
const FLOAT_PIXEL = new Float32Array([0.125, -2.5, 3.75, 1]);
// WebGPU queue.writeBuffer requires a four-byte write; the R8 copy extent consumes only byte zero.
const SINGLE_CHANNEL_STAGING_PIXEL = new Uint8Array([203, 0, 0, 0]);
const SINGLE_CHANNEL_PIXEL = SINGLE_CHANNEL_STAGING_PIXEL.subarray(0, 1);
const TWO_CHANNEL_STAGING_PIXEL = new Uint8Array([37, 211, 0, 0]);
const TWO_CHANNEL_PIXEL = TWO_CHANNEL_STAGING_PIXEL.subarray(0, 2);
const SRGB_PIXEL = new Uint8Array([61, 127, 193, 255]);

export interface WebGpuTextureCopyGolden {
  readonly matchesSource: boolean;
  readonly integerMatchesSource: boolean;
  readonly halfFloatMatchesSource: boolean;
  readonly floatMatchesSource: boolean;
  readonly singleChannelMatchesSource: boolean;
  readonly twoChannelMatchesSource: boolean;
  readonly srgbMatchesSource: boolean;
  readonly bytes: readonly number[];
}

/** Exercises the public RHI buffer-texture copy route and validates browser readback bytes. */
export async function runWebGpuTextureCopyGolden(
  session: BrowserGraphicsSession
): Promise<WebGpuTextureCopyGolden> {
  const source = session.device.createBuffer({
    label: 'e2e-copy-source',
    size: COPY_ROW_BYTES,
    usage: COPY_SRC | COPY_DST
  });
  const readback = session.device.createBuffer({
    label: 'e2e-copy-readback',
    size: COPY_ROW_BYTES,
    usage: COPY_DST | MAP_READ
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
  try {
    session.device.queue.writeBuffer(source, 0, PIXEL);
    const encoder = session.device.createCommandEncoder({ label: 'e2e-buffer-texture-copy' });
    encoder.copyBufferToTexture(
      { buffer: source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture },
      [1, 1]
    );
    encoder.copyTextureToTexture({ texture }, { texture: copiedTexture }, [1, 1]);
    encoder.copyTextureToBuffer(
      { texture: copiedTexture },
      { buffer: readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed') {
      throw new Error(`WebGPU texture-copy submission ended with ${submission.status}.`);
    }
    await readback.mapAsync(MAP_READ);
    const bytes = Array.from(new Uint8Array(readback.getMappedRange().slice(0, PIXEL.byteLength)));
    readback.unmap();
    const matchesSource = bytes.every((value, index) => value === PIXEL[index]);
    if (!matchesSource) {
      throw new Error(`WebGPU texture-copy readback mismatch: expected ${PIXEL}, got ${bytes}.`);
    }
    const integerMatchesSource = await runIntegerTextureCopyGolden(session);
    const halfFloatMatchesSource = await runHalfFloatTextureCopyGolden(session);
    const floatMatchesSource = await runFloatTextureCopyGolden(session);
    const singleChannelMatchesSource = await runSingleChannelTextureCopyGolden(session);
    const twoChannelMatchesSource = await runTwoChannelTextureCopyGolden(session);
    const srgbMatchesSource = await runSrgbTextureCopyGolden(session);
    return Object.freeze({
      matchesSource,
      integerMatchesSource,
      halfFloatMatchesSource,
      floatMatchesSource,
      singleChannelMatchesSource,
      twoChannelMatchesSource,
      srgbMatchesSource,
      bytes: Object.freeze(bytes)
    });
  } finally {
    copiedTexture.dispose();
    texture.dispose();
    readback.dispose();
    source.dispose();
  }
}

async function runSrgbTextureCopyGolden(session: BrowserGraphicsSession): Promise<boolean> {
  const source = session.device.createBuffer({
    label: 'e2e-srgb-copy-source',
    size: COPY_ROW_BYTES,
    usage: COPY_SRC | COPY_DST
  });
  const readback = session.device.createBuffer({
    label: 'e2e-srgb-copy-readback',
    size: COPY_ROW_BYTES,
    usage: COPY_DST | MAP_READ
  });
  const texture = session.device.createTexture({
    label: 'e2e-srgb-copy-texture',
    size: [1, 1],
    format: 'rgba8unorm-srgb',
    usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
  });
  const copiedTexture = session.device.createTexture({
    label: 'e2e-srgb-copy-target',
    size: [1, 1],
    format: 'rgba8unorm-srgb',
    usage: TEXTURE_COPY_SRC | TEXTURE_COPY_DST
  });
  try {
    session.device.queue.writeBuffer(source, 0, SRGB_PIXEL);
    const encoder = session.device.createCommandEncoder({ label: 'e2e-srgb-buffer-texture-copy' });
    encoder.copyBufferToTexture(
      { buffer: source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture },
      [1, 1]
    );
    encoder.copyTextureToTexture({ texture }, { texture: copiedTexture }, [1, 1]);
    encoder.copyTextureToBuffer(
      { texture: copiedTexture },
      { buffer: readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed')
      throw new Error(`WebGPU sRGB texture-copy submission ended with ${submission.status}.`);
    await readback.mapAsync(MAP_READ);
    const bytes = new Uint8Array(readback.getMappedRange().slice(0, SRGB_PIXEL.byteLength));
    readback.unmap();
    const matches = bytes.every((value, index) => value === SRGB_PIXEL[index]);
    if (!matches) throw new Error('WebGPU sRGB texture-copy readback mismatch.');
    return true;
  } finally {
    copiedTexture.dispose();
    texture.dispose();
    readback.dispose();
    source.dispose();
  }
}

async function runTwoChannelTextureCopyGolden(session: BrowserGraphicsSession): Promise<boolean> {
  const source = session.device.createBuffer({
    label: 'e2e-rg8-copy-source',
    size: COPY_ROW_BYTES,
    usage: COPY_SRC | COPY_DST
  });
  const readback = session.device.createBuffer({
    label: 'e2e-rg8-copy-readback',
    size: COPY_ROW_BYTES,
    usage: COPY_DST | MAP_READ
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
  try {
    session.device.queue.writeBuffer(source, 0, TWO_CHANNEL_STAGING_PIXEL);
    const encoder = session.device.createCommandEncoder({ label: 'e2e-rg8-buffer-texture-copy' });
    encoder.copyBufferToTexture(
      { buffer: source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture },
      [1, 1]
    );
    encoder.copyTextureToTexture({ texture }, { texture: copiedTexture }, [1, 1]);
    encoder.copyTextureToBuffer(
      { texture: copiedTexture },
      { buffer: readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed')
      throw new Error(`WebGPU RG8 texture-copy submission ended with ${submission.status}.`);
    await readback.mapAsync(MAP_READ);
    const bytes = new Uint8Array(readback.getMappedRange().slice(0, TWO_CHANNEL_PIXEL.byteLength));
    readback.unmap();
    const matches = bytes.every((value, index) => value === TWO_CHANNEL_PIXEL[index]);
    if (!matches) throw new Error('WebGPU RG8 texture-copy readback mismatch.');
    return true;
  } finally {
    copiedTexture.dispose();
    texture.dispose();
    readback.dispose();
    source.dispose();
  }
}

async function runSingleChannelTextureCopyGolden(
  session: BrowserGraphicsSession
): Promise<boolean> {
  const source = session.device.createBuffer({
    label: 'e2e-r8-copy-source',
    size: COPY_ROW_BYTES,
    usage: COPY_SRC | COPY_DST
  });
  const readback = session.device.createBuffer({
    label: 'e2e-r8-copy-readback',
    size: COPY_ROW_BYTES,
    usage: COPY_DST | MAP_READ
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
  try {
    session.device.queue.writeBuffer(source, 0, SINGLE_CHANNEL_STAGING_PIXEL);
    const encoder = session.device.createCommandEncoder({ label: 'e2e-r8-buffer-texture-copy' });
    encoder.copyBufferToTexture(
      { buffer: source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture },
      [1, 1]
    );
    encoder.copyTextureToTexture({ texture }, { texture: copiedTexture }, [1, 1]);
    encoder.copyTextureToBuffer(
      { texture: copiedTexture },
      { buffer: readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed') {
      throw new Error(`WebGPU R8 texture-copy submission ended with ${submission.status}.`);
    }
    await readback.mapAsync(MAP_READ);
    const bytes = new Uint8Array(
      readback.getMappedRange().slice(0, SINGLE_CHANNEL_PIXEL.byteLength)
    );
    readback.unmap();
    const matches = bytes.every((value, index) => value === SINGLE_CHANNEL_PIXEL[index]);
    if (!matches) throw new Error('WebGPU R8 texture-copy readback mismatch.');
    return true;
  } finally {
    copiedTexture.dispose();
    texture.dispose();
    readback.dispose();
    source.dispose();
  }
}

async function runFloatTextureCopyGolden(session: BrowserGraphicsSession): Promise<boolean> {
  const source = session.device.createBuffer({
    label: 'e2e-float-copy-source',
    size: COPY_ROW_BYTES,
    usage: COPY_SRC | COPY_DST
  });
  const readback = session.device.createBuffer({
    label: 'e2e-float-copy-readback',
    size: COPY_ROW_BYTES,
    usage: COPY_DST | MAP_READ
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
  try {
    session.device.queue.writeBuffer(source, 0, FLOAT_PIXEL);
    const encoder = session.device.createCommandEncoder({ label: 'e2e-float-buffer-texture-copy' });
    encoder.copyBufferToTexture(
      { buffer: source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture },
      [1, 1]
    );
    encoder.copyTextureToTexture({ texture }, { texture: copiedTexture }, [1, 1]);
    encoder.copyTextureToBuffer(
      { texture: copiedTexture },
      { buffer: readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed') {
      throw new Error(`WebGPU float texture-copy submission ended with ${submission.status}.`);
    }
    await readback.mapAsync(MAP_READ);
    const values = new Float32Array(readback.getMappedRange().slice(0, FLOAT_PIXEL.byteLength));
    readback.unmap();
    const matches = values.every((value, index) => value === FLOAT_PIXEL[index]);
    if (!matches) throw new Error('WebGPU float texture-copy readback mismatch.');
    return true;
  } finally {
    copiedTexture.dispose();
    texture.dispose();
    readback.dispose();
    source.dispose();
  }
}

async function runHalfFloatTextureCopyGolden(session: BrowserGraphicsSession): Promise<boolean> {
  const source = session.device.createBuffer({
    label: 'e2e-half-float-copy-source',
    size: COPY_ROW_BYTES,
    usage: COPY_SRC | COPY_DST
  });
  const readback = session.device.createBuffer({
    label: 'e2e-half-float-copy-readback',
    size: COPY_ROW_BYTES,
    usage: COPY_DST | MAP_READ
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
  try {
    session.device.queue.writeBuffer(source, 0, HALF_FLOAT_PIXEL);
    const encoder = session.device.createCommandEncoder({
      label: 'e2e-half-float-buffer-texture-copy'
    });
    encoder.copyBufferToTexture(
      { buffer: source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture },
      [1, 1]
    );
    encoder.copyTextureToTexture({ texture }, { texture: copiedTexture }, [1, 1]);
    encoder.copyTextureToBuffer(
      { texture: copiedTexture },
      { buffer: readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed') {
      throw new Error(`WebGPU half-float texture-copy submission ended with ${submission.status}.`);
    }
    await readback.mapAsync(MAP_READ);
    const words = new Uint16Array(readback.getMappedRange().slice(0, HALF_FLOAT_PIXEL.byteLength));
    readback.unmap();
    const matches = words.every((value, index) => value === HALF_FLOAT_PIXEL[index]);
    if (!matches) throw new Error('WebGPU half-float texture-copy readback mismatch.');
    return true;
  } finally {
    copiedTexture.dispose();
    texture.dispose();
    readback.dispose();
    source.dispose();
  }
}

async function runIntegerTextureCopyGolden(session: BrowserGraphicsSession): Promise<boolean> {
  const source = session.device.createBuffer({
    label: 'e2e-integer-copy-source',
    size: COPY_ROW_BYTES,
    usage: COPY_SRC | COPY_DST
  });
  const readback = session.device.createBuffer({
    label: 'e2e-integer-copy-readback',
    size: COPY_ROW_BYTES,
    usage: COPY_DST | MAP_READ
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
  try {
    session.device.queue.writeBuffer(source, 0, INTEGER_PIXEL);
    const encoder = session.device.createCommandEncoder({
      label: 'e2e-integer-buffer-texture-copy'
    });
    encoder.copyBufferToTexture(
      { buffer: source, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      { texture },
      [1, 1]
    );
    encoder.copyTextureToTexture({ texture }, { texture: copiedTexture }, [1, 1]);
    encoder.copyTextureToBuffer(
      { texture: copiedTexture },
      { buffer: readback, bytesPerRow: COPY_ROW_BYTES, rowsPerImage: 1 },
      [1, 1]
    );
    const submission = await session.device.queue.submit([encoder.finish()]).done;
    if (submission.status !== 'completed') {
      throw new Error(`WebGPU integer texture-copy submission ended with ${submission.status}.`);
    }
    await readback.mapAsync(MAP_READ);
    const words = new Uint32Array(readback.getMappedRange().slice(0, INTEGER_PIXEL.byteLength));
    readback.unmap();
    const matches = words.every((value, index) => value === INTEGER_PIXEL[index]);
    if (!matches) throw new Error('WebGPU integer texture-copy readback mismatch.');
    return true;
  } finally {
    copiedTexture.dispose();
    texture.dispose();
    readback.dispose();
    source.dispose();
  }
}
