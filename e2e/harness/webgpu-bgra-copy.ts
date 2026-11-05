import type { BrowserGraphicsSession } from '../../src';

/** Checks byte-preserving BGRA copies, including encoded sRGB bytes without color conversion. */
export async function runWebGpuBgraCopyGolden(
  session: BrowserGraphicsSession
): Promise<{ readonly bgraMatchesSource: boolean; readonly bgraSrgbMatchesSource: boolean }> {
  for (const format of ['bgra8unorm', 'bgra8unorm-srgb'] as const) {
    const source = session.device.createBuffer({ size: 256, usage: 12 });
    const readback = session.device.createBuffer({ size: 256, usage: 9 });
    const texture = session.device.createTexture({ size: [1, 1], format, usage: 3 });
    const destination = session.device.createTexture({ size: [1, 1], format, usage: 3 });
    // Distinct B/G/R bytes detect accidental RGBA channel interpretation.
    const expected = new Uint8Array([193, 127, 61, 255]);
    try {
      session.device.queue.writeBuffer(source, 0, expected);
      const encoder = session.device.createCommandEncoder({ label: `e2e-${format}-copy` });
      encoder.copyBufferToTexture({ buffer: source, bytesPerRow: 256 }, { texture }, [1, 1]);
      encoder.copyTextureToTexture({ texture }, { texture: destination }, [1, 1]);
      encoder.copyTextureToBuffer(
        { texture: destination },
        { buffer: readback, bytesPerRow: 256 },
        [1, 1]
      );
      const result = await session.device.queue.submit([encoder.finish()]).done;
      if (result.status !== 'completed')
        throw new Error(`${format} copy ended with ${result.status}.`);
      await readback.mapAsync(1);
      const actual = new Uint8Array(readback.getMappedRange().slice(0, 4));
      readback.unmap();
      if (!actual.every((value, index) => value === expected[index])) {
        throw new Error(`${format} copy changed raw BGRA bytes: ${actual}.`);
      }
    } finally {
      destination.dispose();
      texture.dispose();
      readback.dispose();
      source.dispose();
    }
  }
  return Object.freeze({ bgraMatchesSource: true, bgraSrgbMatchesSource: true });
}
