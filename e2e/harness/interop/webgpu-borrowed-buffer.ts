import {
  WebGPUInteropExtension,
  type BrowserGraphicsSession,
  type WebGPUNativeBufferPort,
  type WebGPUNativeResourcePort
} from '../../../src';

/** Exercises the reviewed interop trust boundary on a real browser-owned device and submission. */
export async function runWebGpuBorrowedBufferGolden(
  session: BrowserGraphicsSession
): Promise<Readonly<Record<string, boolean>>> {
  const interop = session.device.getExtension(WebGPUInteropExtension);
  if (interop === undefined) throw new Error('WebGPU interop extension is missing.');
  const scope = interop.createScope('e2e-reviewed-native-copy', 'aether-owned-submission');
  const createBuffer = scope.device.createBuffer;
  if (createBuffer === undefined) throw new Error('Native interop device cannot create a buffer.');
  const native = requireBuffer(createBuffer.call(scope.device, { size: 16, usage: 12 }));
  const destroyNative = native.destroy;
  if (destroyNative === undefined)
    throw new Error('Native borrowed buffer cannot be destroyed by its owner.');
  const imported = scope.importBorrowed('buffer', native, { size: 16, usage: 12 });
  const intermediate = session.device.createBuffer({ size: 16, usage: 12 });
  const nativeTarget = session.device.createBuffer({ size: 16, usage: 12 });
  const readback = session.device.createBuffer({ size: 16, usage: 9 });
  const expected = new Uint32Array([0x12345678, 0x89abcdef, 0x13579bdf, 0x2468ace0]);
  const second = interop.createScope('e2e-external-owner');
  try {
    let independentSubmissionRejected = false;
    try {
      interop.createScope('e2e-unreviewed-library', 'independent-submission');
    } catch (error) {
      independentSubmissionRejected = error instanceof Error && error.message.includes('isolated');
    }
    if (!independentSubmissionRejected) throw new Error('Independent submission was accepted.');
    session.device.queue.writeBuffer(imported, 0, expected);
    const encoder = session.device.createCommandEncoder({ label: 'e2e-native-borrowed-copy' });
    // Public copies establish leases for every native access. The first readback observes
    // zeroed nativeTarget; only the native command supplies the words read by the final copy.
    encoder.copyBufferToBuffer(imported, 0, intermediate, 0, 16);
    encoder.copyBufferToBuffer(nativeTarget, 0, readback, 0, 16);
    scope
      .unwrapEncoder(encoder)
      .copyBufferToBuffer(
        scope.unwrapResource('buffer', intermediate),
        0,
        scope.unwrapResource('buffer', nativeTarget),
        0,
        16
      );
    encoder.copyBufferToBuffer(nativeTarget, 0, readback, 0, 16);
    const submission = session.device.queue.submit([encoder.finish()]);
    scope.dispose();
    if (imported.state !== 'disposed') throw new Error('Scope cleanup did not dispose its import.');
    const result = await submission.done;
    if (result.status !== 'completed') throw new Error(`Native copy ended with ${result.status}.`);
    await readback.mapAsync(1);
    const actual = new Uint32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    if (!actual.every((value, index) => value === expected[index]))
      throw new Error('Native copy changed buffer words.');

    // Reimport and execute again to prove borrowed scope cleanup did not destroy native storage.
    const borrowedAgain = second.importBorrowed('buffer', native, { size: 16, usage: 12 });
    const verify = session.device.createCommandEncoder();
    verify.copyBufferToBuffer(borrowedAgain, 0, readback, 0, 16);
    const verified = await session.device.queue.submit([verify.finish()]).done;
    if (verified.status !== 'completed')
      throw new Error('Borrowed storage did not survive scope cleanup.');
    await readback.mapAsync(1);
    const retained = new Uint32Array(readback.getMappedRange().slice(0));
    readback.unmap();
    if (!retained.every((value, index) => value === expected[index]))
      throw new Error('Borrowed storage was not retained.');
    return Object.freeze({
      matchesSource: true,
      borrowedSurvivesScopeCleanup: true,
      independentSubmissionRejected
    });
  } finally {
    second.dispose();
    scope.dispose();
    readback.dispose();
    nativeTarget.dispose();
    intermediate.dispose();
    destroyNative.call(native);
  }
}

function requireBuffer(resource: WebGPUNativeResourcePort): WebGPUNativeBufferPort {
  if (
    !('size' in resource) ||
    typeof resource.size !== 'number' ||
    !('usage' in resource) ||
    typeof resource.usage !== 'number'
  ) {
    throw new Error('Native interop buffer lacks size and usage facts.');
  }
  return resource as WebGPUNativeBufferPort;
}
