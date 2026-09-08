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
      destroy(): Promise<void>;
    }>;
  }
}

const root = document.getElementById('root');
if (root === null) throw new Error('Example root element is missing.');

const acceptance = new URLSearchParams(location.search).has('e2e');

createRoot(root).render(
  <StrictMode>
    <App mountScene={!acceptance} />
  </StrictMode>
);

if (acceptance) {
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
      destroy: async () => undefined
    });
  });
}

async function mountForAcceptance(): Promise<void> {
  const canvas = await waitForCanvas();
  const requested = new URLSearchParams(location.search).get('backend');
  const preferences: Readonly<Record<string, readonly ('webgpu' | 'webgl2')[]>> = {
    webgpu: ['webgpu'],
    webgl2: ['webgl2']
  } as const;
  const preference = requested === null ? preferences.webgpu : preferences[requested];
  if (preference === undefined) throw new Error(`Unsupported example backend: ${requested}.`);
  const scene: MountedAetherScene = await mountAetherScene(canvas, {
    preference,
    animate: false,
    ground: false,
    environment: 'synthetic',
    background: 'none',
    metallic: 0.08,
    roughness: 0.42
  });
  const gl = canvas.getContext('webgl2');
  window.__AETHER_EXAMPLE__ = Object.freeze({
    state: () => ({
      backend: scene.backend,
      diagnostics: scene.diagnostics(),
      nativeMetrics: scene.nativeMetrics(),
      nativeError: gl?.getError(),
      validationErrors: scene.validationErrors(),
      runtimeErrors: scene.runtimeErrors()
    }),
    resize: (width, height) => scene.resize(width, height),
    setRotation: (angleRadians) => scene.setRotation(angleRadians),
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
