import { describe, expect, test, vi } from 'vitest';
import type { MountedAetherScene } from '../../examples/react-vite-ts/src/aether-scene';

vi.mock('../../examples/react-vite-ts/src/aether-scene', () => {
  return {
    mountAetherScene: vi.fn(async (canvas: HTMLCanvasElement) => {
      let destroyed = false;
      const scene: MountedAetherScene = {
        backend: 'webgpu',
        environmentMode: 'hdr',
        resize: vi.fn(),
        setRotation: vi.fn(),
        setCastsShadow: vi.fn(),
        setSunlight: vi.fn(),
        setRoughness: vi.fn(),
        setMetallic: vi.fn(),
        setBackgroundMultiplier: vi.fn(),
        setShadowDistance: vi.fn(),
        setLightDirection: vi.fn(),
        diagnostics: vi.fn(() => undefined),
        csmDiagnostics: vi.fn(() => undefined),
        nativeMetrics: vi.fn(() => undefined),
        validationErrors: vi.fn(() => []),
        runtimeErrors: vi.fn(() => []),
        destroy: vi.fn(async () => {
          destroyed = true;
        })
      };
      return scene;
    })
  };
});

import { AetherSceneHost } from '../../examples/react-vite-ts/src/scene-host';
import { mountAetherScene } from '../../examples/react-vite-ts/src/aether-scene';

describe('AetherSceneHost', () => {
  test('mounts a scene and registers it as current for the canvas', async () => {
    const host = new AetherSceneHost();
    const canvas = {} as HTMLCanvasElement;

    const scene = await host.mount(canvas);
    expect(scene).toBeDefined();
    expect(host.isCurrent(canvas)).toBe(true);
    expect(host.activeScene).toBe(scene);

    await host.unmount();
    expect(host.isCurrent(canvas)).toBe(false);
    expect(host.activeScene).toBeNull();
    expect(scene.destroy).toHaveBeenCalledTimes(1);
  });

  test('serializes mount -> unmount -> mount without race conditions', async () => {
    const host = new AetherSceneHost();
    const canvas = {} as HTMLCanvasElement;

    // Simulate React 18 StrictMode: mount -> unmount -> mount fired in the same microtask tick
    const p1 = host.mount(canvas);
    const u1 = host.unmount();
    const p2 = host.mount(canvas);

    // p1 should either reject with cancellation or be destroyed cleanly during u1
    await Promise.allSettled([p1, u1]);
    const finalScene = await p2;

    expect(finalScene).toBeDefined();
    expect(host.isCurrent(canvas)).toBe(true);
    expect(host.activeScene).toBe(finalScene);

    // Clean up
    await host.unmount();
    expect(finalScene.destroy).toHaveBeenCalledTimes(1);
  });

  test('destroys existing scene when re-mounting on a different canvas', async () => {
    const host = new AetherSceneHost();
    const canvas1 = {} as HTMLCanvasElement;
    const canvas2 = {} as HTMLCanvasElement;

    const scene1 = await host.mount(canvas1);
    expect(host.isCurrent(canvas1)).toBe(true);
    expect(host.isCurrent(canvas2)).toBe(false);

    const scene2 = await host.mount(canvas2);
    expect(scene1.destroy).toHaveBeenCalledTimes(1);
    expect(host.isCurrent(canvas1)).toBe(false);
    expect(host.isCurrent(canvas2)).toBe(true);
    expect(host.activeScene).toBe(scene2);

    await host.unmount();
    expect(scene2.destroy).toHaveBeenCalledTimes(1);
  });

  test('serializes in-flight initialization when cleanup is immediately followed by setup', async () => {
    const host = new AetherSceneHost();
    const canvas = {} as HTMLCanvasElement;

    let resolveInit1!: () => void;
    const init1Promise = new Promise<void>((res) => {
      resolveInit1 = res;
    });

    let notifyInit1Started!: () => void;
    const init1StartedPromise = new Promise<void>((res) => {
      notifyInit1Started = res;
    });

    let init1Destroyed = false;

    vi.mocked(mountAetherScene).mockImplementationOnce(async () => {
      notifyInit1Started();
      await init1Promise;
      return {
        backend: 'webgpu',
        environmentMode: 'hdr',
        resize: vi.fn(),
        setRotation: vi.fn(),
        setCastsShadow: vi.fn(),
        setSunlight: vi.fn(),
        setRoughness: vi.fn(),
        setMetallic: vi.fn(),
        setBackgroundMultiplier: vi.fn(),
        setShadowDistance: vi.fn(),
        setLightDirection: vi.fn(),
        diagnostics: vi.fn(() => undefined),
        csmDiagnostics: vi.fn(() => undefined),
        nativeMetrics: vi.fn(() => undefined),
        validationErrors: vi.fn(() => []),
        runtimeErrors: vi.fn(() => []),
        destroy: vi.fn(async () => {
          init1Destroyed = true;
        })
      };
    });

    // 1. Mount starts and becomes in-flight
    const p1 = host.mount(canvas);
    // Await deterministic start of mountAetherScene
    await init1StartedPromise;
    expect(init1Destroyed).toBe(false);

    // 2. React StrictMode unmount (cleanup) triggered while init 1 is still in-flight
    const u1 = host.unmount();

    // 3. React StrictMode mount (setup) triggered immediately afterwards
    const p2 = host.mount(canvas);

    // At this point, init 1 has not resolved yet, so p2 must NOT have started mountAetherScene
    expect(init1Destroyed).toBe(false);

    // 4. Resolve init 1
    resolveInit1();

    // p1 should reject because it was aborted during initialization
    await expect(p1).rejects.toThrowError('Scene mount cancelled during initialization.');

    // Wait for p2 (the new mount) to complete
    const finalScene = await p2;

    // Verify init 1 was destroyed BEFORE the host settled on the new scene
    expect(init1Destroyed).toBe(true);
    expect(finalScene).toBeDefined();
    expect(host.isCurrent(canvas)).toBe(true);
    expect(host.activeScene).toBe(finalScene);

    // Clean up
    await host.unmount();
    expect(finalScene.destroy).toHaveBeenCalledTimes(1);
  });

  test('prevents canvas ownership conflicts when shared host serializes in-flight re-mount', async () => {
    // Verify that AetherSceneHost completely prevents canvas-ownership-conflict
    const host = new AetherSceneHost();
    const canvas = {} as HTMLCanvasElement;
    let activeSessionOnCanvas: string | null = null;

    vi.mocked(mountAetherScene).mockImplementation(async (_canvas, options) => {
      const sessionId = `session-${Math.random().toString(36).slice(2, 8)}`;
      if (activeSessionOnCanvas !== null) {
        throw new Error(
          `[canvas-ownership-conflict] Canvas already owned by ${activeSessionOnCanvas}`
        );
      }
      activeSessionOnCanvas = sessionId;

      return {
        backend: 'webgpu',
        environmentMode: options?.environment ?? 'hdr',
        resize: vi.fn(),
        setRotation: vi.fn(),
        setCastsShadow: vi.fn(),
        setSunlight: vi.fn(),
        setRoughness: vi.fn(),
        setMetallic: vi.fn(),
        setBackgroundMultiplier: vi.fn(),
        setShadowDistance: vi.fn(),
        setLightDirection: vi.fn(),
        diagnostics: vi.fn(() => undefined),
        csmDiagnostics: vi.fn(() => undefined),
        nativeMetrics: vi.fn(() => undefined),
        validationErrors: vi.fn(() => []),
        runtimeErrors: vi.fn(() => []),
        destroy: vi.fn(async () => {
          if (activeSessionOnCanvas === sessionId) {
            activeSessionOnCanvas = null;
          }
        })
      };
    });

    // Rapid mount -> unmount -> mount
    const p1 = host.mount(canvas);
    const u1 = host.unmount();
    const p2 = host.mount(canvas);

    await Promise.allSettled([p1, u1]);
    const scene2 = await p2;

    expect(scene2).toBeDefined();
    expect(host.activeScene).toBe(scene2);

    await host.unmount();
    expect(activeSessionOnCanvas).toBeNull();
  });

  test('persisting host in hostRef ensures multiple effect mount cycles are serialized', async () => {
    // Simulates App component: hostRef.current persists across effect runs
    const hostRef = { current: new AetherSceneHost() };
    const canvas = {} as HTMLCanvasElement;

    // First effect mount
    const p1 = hostRef.current.mount(canvas);
    // Cleanup of first effect
    const u1 = hostRef.current.unmount();
    // Second effect mount (shares same hostRef.current)
    const p2 = hostRef.current.mount(canvas);

    await Promise.allSettled([p1, u1]);
    const active = await p2;
    expect(active).toBeDefined();
    expect(hostRef.current.isCurrent(canvas)).toBe(true);

    await hostRef.current.unmount();
  });
});
