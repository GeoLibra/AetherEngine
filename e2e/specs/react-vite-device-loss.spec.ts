import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { MountedAetherScene } from '../../examples/react-vite-ts/src/aether-scene';

interface CapturedDeviceSnapshot {
  readonly id: number;
  readonly label: string;
  readonly adapter: Readonly<Record<string, string>>;
  readonly loss: Readonly<{ reason: string; message: string }> | null;
}

interface DeviceLossProbe {
  snapshot(): readonly CapturedDeviceSnapshot[];
  requestCount(): number;
  destroyActiveDevice(): Promise<Readonly<{ id: number; reason: string; message: string }>>;
}

declare global {
  interface Window {
    __WEBGPU_DEVICE_LOSS_PROBE__?: DeviceLossProbe;
  }
}

test('WebGPU native device destruction terminates the scene generation without recreation', async ({
  page,
  browser
}, info) => {
  test.skip(!info.project.name.endsWith('webgpu'), 'Native GPUDevice loss applies only to WebGPU.');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(installNativeDeviceProbe);
  await page.goto('/?backend=webgpu&samples=4');
  await expect(page.locator('.status-ready')).toBeVisible({ timeout: 25_000 });

  const initial = await page.evaluate(() => {
    const scene = window.__aetherScene as MountedAetherScene | undefined;
    const probe = window.__WEBGPU_DEVICE_LOSS_PROBE__;
    if (scene?.lost === undefined || probe === undefined)
      throw new Error('Rendered WebGPU scene and native device capture are required.');
    return {
      backend: scene.backend,
      diagnostics: scene.diagnostics(),
      validationErrors: scene.validationErrors(),
      runtimeErrors: scene.runtimeErrors(),
      deviceRequests: probe.requestCount(),
      devices: probe.snapshot()
    };
  });
  expect(initial.backend).toBe('webgpu');
  expect(initial.diagnostics).toMatchObject({ status: 'rendered', sampleCount: 4 });
  expect(initial.validationErrors).toEqual([]);
  expect(initial.runtimeErrors).toEqual([]);
  expect(initial.devices.filter((device) => device.loss === null)).toHaveLength(1);
  expect(initial.deviceRequests).toBe(initial.devices.length);

  const terminated = await page.evaluate(async () => {
    const scene = window.__aetherScene as MountedAetherScene | undefined;
    const probe = window.__WEBGPU_DEVICE_LOSS_PROBE__;
    if (scene?.lost === undefined || probe === undefined)
      throw new Error('Mounted WebGPU scene and device capture are missing.');
    const nativeLoss = await probe.destroyActiveDevice();
    const sceneLoss = await scene.lost;
    // Drain the host's loss continuation before starting the bounded observation.
    await scene.recoveryReady;
    const devicesAtLoss = probe.snapshot();
    let replaced = false;
    for (let frame = 0; frame < 30; frame += 1) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (window.__aetherScene !== scene) replaced = true;
    }
    return {
      nativeLoss,
      sceneLoss,
      replaced,
      devicesAtLoss,
      devicesAfterObservation: probe.snapshot(),
      deviceRequestsAfterObservation: probe.requestCount(),
      diagnostics: scene.diagnostics(),
      metrics: scene.nativeMetrics()
    };
  });
  const evidencePath = info.outputPath('webgpu-native-device-destruction.json');
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        environment: {
          platform: process.platform,
          architecture: process.arch,
          browserVersion: browser.version(),
          project: info.project.name,
          observationFrames: 30
        },
        initial,
        terminated,
        pageErrors
      },
      null,
      2
    )
  );
  await info.attach('webgpu-native-device-destruction', {
    path: evidencePath,
    contentType: 'application/json'
  });
  expect(terminated.nativeLoss.reason).toBe('destroyed');
  expect(terminated.sceneLoss).toMatchObject({
    backend: 'webgpu',
    stage: 'device',
    reason: 'destroyed',
    recreationAllowed: false
  });
  expect(terminated.sceneLoss.generation).toBeGreaterThan(0);
  expect(terminated.replaced).toBe(false);
  expect(terminated.devicesAfterObservation).toEqual(terminated.devicesAtLoss);
  expect(terminated.devicesAfterObservation).toHaveLength(initial.devices.length);
  expect(terminated.deviceRequestsAfterObservation).toBe(initial.deviceRequests);
  expect(terminated.metrics).toMatchObject({ pending: 0, leasedResources: 0 });
  expect(pageErrors).toEqual([]);

  // Teardown stays explicit for a non-recoverable loss; the host must not remount it.
  await page.evaluate(async () => {
    const scene = window.__aetherScene as MountedAetherScene | undefined;
    if (scene === undefined) throw new Error('Terminated scene is missing.');
    await scene.destroy();
    await scene.destroy();
  });
  expect(pageErrors).toEqual([]);
});

test('WebGPU recovers a real GPU process loss with a new validation-clean scene generation', async ({
  page,
  browser
}, info) => {
  test.skip(!info.project.name.endsWith('webgpu'), 'Native GPUDevice loss applies only to WebGPU.');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.addInitScript(installNativeDeviceProbe);
  await page.goto('/?backend=webgpu&samples=4');
  await expect(page.locator('.status-ready')).toBeVisible({ timeout: 25_000 });
  const previous = await page.evaluateHandle(() => {
    const scene = window.__aetherScene as MountedAetherScene | undefined;
    if (scene?.lost === undefined) throw new Error('Mounted WebGPU scene is missing.');
    return scene;
  });
  const initial = await previous.evaluate((scene) => ({
    backend: scene.backend,
    diagnostics: scene.diagnostics(),
    validationErrors: scene.validationErrors(),
    runtimeErrors: scene.runtimeErrors(),
    devices: window.__WEBGPU_DEVICE_LOSS_PROBE__!.snapshot()
  }));
  expect(initial.backend).toBe('webgpu');
  expect(initial.diagnostics).toMatchObject({ status: 'rendered', sampleCount: 4 });
  expect(initial.validationErrors).toEqual([]);
  expect(initial.runtimeErrors).toEqual([]);

  // CDP targets this Playwright worker's browser, never an existing user browser.
  const cdp = await browser.newBrowserCDPSession();
  await cdp.send('Browser.crashGpuProcess');
  await cdp.detach();
  const loss = await previous.evaluate((scene) => scene.lost);
  expect(loss).toMatchObject({ backend: 'webgpu', stage: 'device', recreationAllowed: true });
  expect(loss?.reason).not.toBe('destroyed');
  expect(loss?.generation).toBe(initial.diagnostics?.deviceGeneration);
  await expect
    .poll(
      () =>
        previous.evaluate((scene) => {
          const current = window.__aetherScene as MountedAetherScene | undefined;
          return (
            current !== undefined &&
            current !== scene &&
            current.diagnostics()?.status === 'rendered'
          );
        }),
      { timeout: 25_000 }
    )
    .toBe(true);
  const recovered = await page.evaluate(() => {
    const scene = window.__aetherScene as MountedAetherScene | undefined;
    const probe = window.__WEBGPU_DEVICE_LOSS_PROBE__;
    if (scene === undefined || probe === undefined) throw new Error('Recovered scene is missing.');
    return {
      backend: scene.backend,
      diagnostics: scene.diagnostics(),
      validationErrors: scene.validationErrors(),
      runtimeErrors: scene.runtimeErrors(),
      metrics: scene.nativeMetrics(),
      devices: probe.snapshot(),
      deviceRequests: probe.requestCount()
    };
  });
  const retired = await previous.evaluate((scene) => ({ metrics: scene.nativeMetrics() }));
  const evidencePath = info.outputPath('webgpu-device-loss-recovery.json');
  await writeFile(
    evidencePath,
    JSON.stringify(
      {
        environment: {
          platform: process.platform,
          architecture: process.arch,
          browserVersion: browser.version()
        },
        injection: 'Browser.crashGpuProcess',
        initial,
        loss,
        retired,
        recovered,
        pageErrors
      },
      null,
      2
    )
  );
  await info.attach('webgpu-device-loss-recovery', {
    path: evidencePath,
    contentType: 'application/json'
  });
  expect(recovered.backend).toBe('webgpu');
  expect(recovered.diagnostics).toMatchObject({ status: 'rendered', sampleCount: 4 });
  expect(recovered.diagnostics?.deviceGeneration).toBeGreaterThan(loss!.generation);
  expect(recovered.validationErrors).toEqual([]);
  expect(recovered.runtimeErrors).toEqual([]);
  expect(retired.metrics).toMatchObject({ pending: 0, leasedResources: 0 });
  expect(recovered.devices.filter((device) => device.loss === null)).toHaveLength(1);
  expect(recovered.deviceRequests).toBe(initial.devices.length + 1);
  expect(pageErrors).toEqual([]);
  await previous.dispose();
});

/** Installs page-local instrumentation without altering native device or loss identities. */
function installNativeDeviceProbe(): void {
  interface NativeDevice {
    readonly label: string;
    readonly lost: Promise<{ readonly reason: string; readonly message: string }>;
    destroy(): void;
  }
  interface NativeAdapter {
    readonly info: {
      readonly vendor: string;
      readonly architecture: string;
      readonly device: string;
      readonly description: string;
    };
    requestDevice(descriptor?: object): Promise<NativeDevice>;
  }
  const adapterConstructor = Reflect.get(globalThis, 'GPUAdapter');
  if (typeof adapterConstructor !== 'function') throw new Error('GPUAdapter is unavailable.');
  const prototype = adapterConstructor.prototype as NativeAdapter;
  const requestDevice = prototype.requestDevice;
  let deviceRequests = 0;
  const records: Array<{
    readonly device: NativeDevice;
    readonly id: number;
    readonly adapter: Readonly<Record<string, string>>;
    loss: CapturedDeviceSnapshot['loss'];
  }> = [];
  prototype.requestDevice = async function (descriptor?: object): Promise<NativeDevice> {
    deviceRequests += 1;
    const device = await requestDevice.call(this, descriptor);
    const info = this.info;
    const record = {
      device,
      id: records.length + 1,
      adapter: Object.freeze({
        vendor: info.vendor,
        architecture: info.architecture,
        device: info.device,
        description: info.description
      }),
      loss: null as CapturedDeviceSnapshot['loss']
    };
    records.push(record);
    void device.lost.then((loss) => {
      record.loss = Object.freeze({ reason: loss.reason, message: loss.message });
    });
    return device;
  };
  window.__WEBGPU_DEVICE_LOSS_PROBE__ = Object.freeze({
    requestCount: () => deviceRequests,
    snapshot: () =>
      Object.freeze(
        records.map((record) =>
          Object.freeze({
            id: record.id,
            label: record.device.label,
            adapter: record.adapter,
            loss: record.loss
          })
        )
      ),
    async destroyActiveDevice() {
      const live = records.filter((record) => record.loss === null);
      if (live.length !== 1)
        throw new Error(`Expected one live WebGPU device, found ${live.length}.`);
      const record = live[0];
      if (record === undefined) throw new Error('Active WebGPU device is missing.');
      record.device.destroy();
      const loss = await record.device.lost;
      return Object.freeze({ id: record.id, reason: loss.reason, message: loss.message });
    }
  });
}
