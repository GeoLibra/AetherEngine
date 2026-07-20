import { BrowserHost, type WindowMetrics } from '../../src';
import { createDOMBrowserPort } from './browser-port';
import type { E2EBridge, E2EState } from './types';

type Scenario = 'browser-host' | 'webgl2';
type Cleanup = () => void | Promise<void>;

const INITIAL_WIDTH = 640;
const INITIAL_HEIGHT = 360;

let currentState: E2EState = Object.freeze({ status: 'booting' });
let resizeHarness: ((width: number, height: number, dpr: number) => Promise<void>) | undefined;
const cleanups: Cleanup[] = [];
let teardownPromise: Promise<void> | undefined;

const initialization = initialize().catch((error: unknown) => {
  publishFailed(error);
});

const bridge: E2EBridge = Object.freeze({
  state: () => currentState,
  async resize(width: number, height: number, dpr: number) {
    await initialization;
    if (currentState.status === 'failed') {
      throw new Error(currentState.message);
    }
    if (currentState.status === 'destroyed') {
      throw new Error('The E2E harness is destroyed.');
    }
    if (resizeHarness === undefined) {
      throw new Error('The E2E harness is not ready.');
    }
    await resizeHarness(width, height, dpr);
  },
  teardown() {
    teardownPromise ??= teardownHarness();
    return teardownPromise;
  }
});

window.__AETHER_E2E__ = bridge;

async function teardownHarness(): Promise<void> {
  await initialization;
  try {
    await runCleanups();
  } catch (error) {
    publishFailed(error);
    throw error;
  }
  currentState = Object.freeze({ status: 'destroyed' });
}

async function initialize(): Promise<void> {
  const scenario = readScenario();
  const canvas = createOwnedCanvas();
  cleanups.push(() => canvas.remove());

  let devicePixelRatio = window.devicePixelRatio;
  const port = createDOMBrowserPort(canvas, {
    readDevicePixelRatio: () => devicePixelRatio
  });
  const host = new BrowserHost(port);
  cleanups.push(() => host.destroy());

  const hostWindow = await host.createWindow({
    logicalSize: [INITIAL_WIDTH, INITIAL_HEIGHT],
    devicePixelRatio
  });
  cleanups.push(() => hostWindow.close());

  resizeHarness = async (width, height, dpr) => {
    setCanvasExtent(canvas, width, height, dpr);
    devicePixelRatio = dpr;
    hostWindow.queueMetrics({ logicalSize: [width, height], devicePixelRatio: dpr });
    await commitOneFrame(host);
    publishReady(scenario, metricsDetail(hostWindow.metrics, hostWindow.generation));
  };

  if (scenario === 'webgl2') {
    // This is only real-context availability evidence, not WebGL2Adapter conformance.
    if (canvas.getContext('webgl2') === null) {
      throw new Error('WebGL2 is unavailable.');
    }
  }

  publishReady(scenario, metricsDetail(hostWindow.metrics, hostWindow.generation));
}

function readScenario(): Scenario {
  const scenario = new URLSearchParams(window.location.search).get('scenario');
  if (scenario === 'browser-host' || scenario === 'webgl2') return scenario;
  throw new Error(`Unsupported E2E scenario: ${scenario ?? '(missing)'}.`);
}

function createOwnedCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.setAttribute('aria-label', 'AetherEngine E2E surface');
  setCanvasExtent(canvas, INITIAL_WIDTH, INITIAL_HEIGHT, window.devicePixelRatio);
  document.body.append(canvas);
  return canvas;
}

function setCanvasExtent(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  dpr: number
): void {
  validateExtent(width, height, dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
}

function validateExtent(width: number, height: number, dpr: number): void {
  if (![width, height].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error('E2E resize width and height must be non-negative finite numbers.');
  }
  if (!Number.isFinite(dpr) || dpr <= 0) {
    throw new Error('E2E resize DPR must be a positive finite number.');
  }
}

async function commitOneFrame(host: BrowserHost): Promise<void> {
  const runner = host.createRunner({ kind: 'browser' });
  await runner.run({
    stopRequested: false,
    frame() {
      runner.requestStop('e2e-frame-boundary');
      return { frame: 1 };
    }
  });
}

function metricsDetail(
  metrics: WindowMetrics,
  generation: number
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    logicalSize: freezeSize(metrics.logicalSize),
    physicalSize: freezeSize(metrics.physicalSize),
    devicePixelRatio: metrics.devicePixelRatio,
    generation
  });
}

function publishReady(
  backend: 'browser-host' | 'webgl2',
  detail: Readonly<Record<string, unknown>>
): void {
  currentState = Object.freeze({
    status: 'ready',
    host: 'browser',
    backend,
    detail
  });
}

function publishFailed(error: unknown): void {
  currentState = Object.freeze({
    status: 'failed',
    message: error instanceof Error ? error.message : String(error)
  });
}

async function runCleanups(): Promise<void> {
  const errors: unknown[] = [];
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup === undefined) continue;
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  resizeHarness = undefined;
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, `E2E harness cleanup failed (${errors.length}).`);
  }
}

function freezeSize(size: readonly [number, number]): readonly [number, number] {
  return Object.freeze([size[0], size[1]]);
}
