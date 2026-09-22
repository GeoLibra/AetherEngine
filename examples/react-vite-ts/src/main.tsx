import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { mountAetherScene, type MountedAetherScene } from './aether-scene';
import './styles.css';

declare global {
  interface Window {
    __AETHER_EXAMPLE__?: Readonly<{
      state(): Readonly<Record<string, unknown>>;
      resize(width: number, height: number): Promise<void> | void;
      setRotation(angleRadians: number): Promise<void> | void;
      setCastsShadow(enabled: boolean): void;
      destroy(): Promise<void>;
    }>;
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('Example root element is missing.');

const acceptance = new URLSearchParams(location.search).has('e2e');
const acceptanceUsesStandaloneBoxScene = acceptance && location.pathname === '/';

const app = <App mountScene={!acceptanceUsesStandaloneBoxScene} />;
createRoot(root).render(acceptance ? app : <StrictMode>{app}</StrictMode>);

if (acceptanceUsesStandaloneBoxScene) {
  void mountForAcceptance().catch((error: unknown) => {
    const cause = error instanceof Error ? Reflect.get(error, 'cause') : undefined;
    window.__AETHER_EXAMPLE__ = Object.freeze({
      state: () => ({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
        cause: cause instanceof Error ? cause.message : String(cause)
      }),
      resize: () => undefined,
      setRotation: () => undefined,
      setCastsShadow: () => undefined,
      destroy: async () => undefined
    });
  });
}

async function mountForAcceptance(): Promise<void> {
  const canvas = await waitForCanvas();
  const query = new URLSearchParams(location.search);
  const requested = query.get('backend');
  const sampleCount = query.get('samples') === '4' ? 4 : undefined;
  const requestedLocalShadow = query.get('localShadow');
  const localShadow =
    requestedLocalShadow === 'spot' || requestedLocalShadow === 'point'
      ? requestedLocalShadow
      : 'none';
  const preferences: Readonly<Record<string, readonly ('webgpu' | 'webgl2')[]>> = {
    webgpu: ['webgpu'],
    webgl2: ['webgl2']
  } as const;
  const preference = requested === null ? preferences.webgpu : preferences[requested];
  if (preference === undefined) throw new Error(`Unsupported example backend: ${requested}.`);
  const scene: MountedAetherScene = await mountAetherScene(canvas, {
    preference,
    animate: false,
    ground: true,
    environment: 'hdr',
    background: 'hdr',
    metallic: 0.85,
    roughness: 0.15,
    localShadow,
    ...(sampleCount === undefined ? {} : { sampleCount })
  });
  const gl = canvas.getContext('webgl2');
  window.__AETHER_EXAMPLE__ = Object.freeze({
    state: () => ({
      backend: scene.backend,
      environmentMode: scene.environmentMode,
      backgroundMode: scene.backgroundMode,
      diagnostics: scene.diagnostics(),
      nativeMetrics: scene.nativeMetrics(),
      nativeError: gl?.getError(),
      validationErrors: scene.validationErrors(),
      runtimeErrors: scene.runtimeErrors()
    }),
    resize: (width, height) => scene.resize(width, height),
    setRotation: (angleRadians) => scene.setRotation(angleRadians),
    setCastsShadow: (enabled) => scene.setCastsShadow(enabled),
    destroy: () => scene.destroy()
  });
}

async function waitForCanvas(): Promise<HTMLCanvasElement> {
  for (let frame = 0; frame < 60; frame++) {
    const canvas = document.querySelector('canvas');
    if (canvas instanceof HTMLCanvasElement) return canvas;
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
  throw new Error('Example canvas is missing after React mount.');
}
