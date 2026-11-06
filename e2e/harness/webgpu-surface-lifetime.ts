import {
  createBrowserGraphics,
  WebGPUInteropExtension,
  type BrowserGraphicsSession,
  type RHISurfaceFrame,
  type RHITextureView
} from '../../src';

/** Verifies native canvas expiry separately from Aether's explicit frame release boundary. */
export async function runWebGpuSurfaceLifetime(): Promise<Readonly<Record<string, unknown>>> {
  const canvas = document.createElement('canvas');
  canvas.width = 16;
  canvas.height = 16;
  document.body.append(canvas);
  const session = await createBrowserGraphics({
    canvas,
    preference: ['webgpu'],
    device: { requiredFeatures: [], optionalFeatures: [] },
    surface: { width: 16, height: 16, alphaMode: 'opaque' }
  });
  const interop = session.device.getExtension(WebGPUInteropExtension);
  if (interop === undefined) throw new Error('Surface lifetime requires WebGPU interop.');
  const scope = interop.createScope('e2e-surface-lifetime');
  const native = scope.device;
  if (native.pushErrorScope === undefined || native.popErrorScope === undefined)
    throw new Error('Surface lifetime requires native validation error scopes.');
  const errors: Array<string | null> = [];
  const clear = (view: RHITextureView): void => {
    const encoder = session.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{ view, loadOp: 'clear', storeOp: 'store', clearValue: [0, 1, 0, 1] }]
    });
    pass.end();
    session.device.queue.submit([encoder.finish()]);
  };
  const checkedClear = async (view: RHITextureView): Promise<string | null> => {
    native.pushErrorScope!('validation');
    clear(view);
    const error = await native.popErrorScope!();
    const message = error === null ? null : error.message;
    errors.push(message);
    return message;
  };
  try {
    // Microtasks do not run the browser's canvas expiry algorithm.
    const microtask = acquire(session);
    const microtaskView = microtask.texture.createView();
    await Promise.resolve();
    const microtaskError = await checkedClear(microtaskView);
    microtask.present();
    microtaskView.dispose();

    const expired = acquire(session);
    const expiredView = expired.texture.createView();
    // The second callback guarantees an intervening rendering update, rather than
    // relying on timer delays or assuming that the first rAF already expired it.
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
    );
    const expiryError = await checkedClear(expiredView);
    expired.release();
    expiredView.dispose();

    const reconfigured = acquire(session);
    session.resize({ width: 17, height: 16 });
    let reconfigureError: string | null = null;
    try {
      reconfigured.texture.createView();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      reconfigureError = error.message;
    }
    const recovered = acquire(session);
    const recoveredView = recovered.texture.createView();
    const recoveryError = await checkedClear(recoveredView);
    recovered.present();
    recoveredView.dispose();
    await native.queue.onSubmittedWorkDone();
    return Object.freeze({
      adapter: session.adapter.info,
      microtaskError,
      expiryError,
      expiredFrameState: expired.state,
      expiredTextureState: expired.texture.state,
      reconfigureError,
      reconfiguredFrameState: reconfigured.state,
      reconfiguredTextureState: reconfigured.texture.state,
      recoveryError,
      recoveredFrameState: recovered.state,
      queue: session.device.queue.metrics(),
      errors
    });
  } finally {
    scope.dispose();
    await session.destroy();
    canvas.remove();
  }
}

function acquire(session: BrowserGraphicsSession): RHISurfaceFrame {
  const result = session.surface.acquire();
  if (result.status !== 'success') throw new Error(`Surface acquire failed: ${result.status}.`);
  return result.frame;
}
