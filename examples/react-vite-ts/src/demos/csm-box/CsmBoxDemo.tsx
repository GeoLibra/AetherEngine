import { useEffect, useRef, useState } from 'react';
import { LevaPanel, useControls, folder, useCreateStore } from 'leva';
import type { MountedAetherScene } from '../../aether-scene';
import { AetherSceneHost } from '../../scene-host';
import type { DemoProps } from '../types';

type Status =
  | Readonly<{ kind: 'loading'; message: string }>
  | Readonly<{ kind: 'ready'; message: string }>
  | Readonly<{ kind: 'error'; message: string }>;

const VALID_BACKENDS = new Set(['webgpu', 'webgl2'] as const);

// Read backend preference once from URL query parameter (?backend=webgl2 or ?backend=webgpu)
const STATIC_BACKEND_PREFERENCE = (() => {
  if (typeof window === 'undefined') return undefined;
  const requested = new URLSearchParams(window.location.search).get('backend');
  const hasPreference = VALID_BACKENDS.has(requested as any);
  return hasPreference ? ([requested as 'webgpu' | 'webgl2'] as const) : undefined;
})();

export function CsmBoxDemo({ mountScene = true }: DemoProps) {
  const store = useCreateStore();
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<MountedAetherScene | null>(null);
  const hostRef = useRef<AetherSceneHost | null>(null);
  if (hostRef.current === null) {
    hostRef.current = new AetherSceneHost();
  }
  const [status, setStatus] = useState<Status>({
    kind: 'loading',
    message: 'Starting Aether Engine…'
  });

  // Leva controls
  const [
    {
      castsShadow,
      sunlight,
      lightAngle,
      shadowDistance,
      environmentMode,
      backgroundMode,
      backgroundMultiplier,
      metallic,
      roughness
    }
  ] = useControls(
    () => ({
      'Environment & Lighting': folder({
        environmentMode: {
          value: 'venice_sunset',
          options: {
            'Venice Sunset (1K HDR)': 'venice_sunset',
            'Relax Inn Seaview (4K HDR)': 'relax_inn',
            'Synthetic Fallback': 'synthetic'
          },
          label: 'Environment IBL'
        },
        backgroundMode: {
          value: 'hdr',
          options: {
            'HDR Skybox': 'hdr',
            'Solid Color': 'solid',
            'None (Black)': 'none'
          },
          label: 'Background'
        },
        backgroundMultiplier: {
          value: 1.0,
          min: 0.0,
          max: 3.0,
          step: 0.1,
          label: 'Sky Multiplier'
        },
        sunlight: { value: true, label: 'Sunlight (12k Lux)' },
        castsShadow: { value: true, label: 'Cast Shadows' },
        lightAngle: { value: 45, min: 0, max: 360, step: 1, label: 'Light Azimuth (°)' },
        shadowDistance: { value: 25, min: 5, max: 60, step: 1, label: 'Shadow Dist (m)' }
      }),
      'Object Material': folder({
        metallic: { value: 0.85, min: 0.0, max: 1.0, step: 0.01, label: 'Metallic' },
        roughness: { value: 0.15, min: 0.0, max: 1.0, step: 0.01, label: 'Roughness' }
      })
    }),
    { store },
    []
  );

  // Sync Leva control updates into the 3D scene in real-time without unmounting
  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.setCastsShadow(castsShadow);
    sceneRef.current.setSunlight(sunlight);
    sceneRef.current.setShadowDistance(shadowDistance);
    sceneRef.current.setMetallic(metallic);
    sceneRef.current.setRoughness(roughness);
    sceneRef.current.setBackgroundMultiplier(backgroundMultiplier);
    const rad = (lightAngle * Math.PI) / 180;
    sceneRef.current.setLightDirection([Math.cos(rad) * -0.7, -1, Math.sin(rad) * -0.7]);
  }, [
    castsShadow,
    sunlight,
    shadowDistance,
    metallic,
    roughness,
    lightAngle,
    backgroundMultiplier
  ]);

  // Mount Aether scene via serialized lifecycle host (only remounts on environment/background change)
  useEffect(() => {
    if (!mountScene) return;
    const target = canvas.current;
    if (target === null) return;
    const host = hostRef.current!;
    let cancelled = false;

    setStatus({
      kind: 'loading',
      message: `Loading ${environmentMode === 'synthetic' ? 'Synthetic' : environmentMode === 'relax_inn' ? 'Relax Inn 4K HDR' : 'Venice Sunset HDR'} environment…`
    });

    void host
      .mount(target, {
        ...(STATIC_BACKEND_PREFERENCE ? { preference: STATIC_BACKEND_PREFERENCE } : {}),
        environment: environmentMode as any,
        background: backgroundMode as 'hdr' | 'solid' | 'none',
        backgroundMultiplier,
        metallic,
        roughness,
        sunlight
      })
      .then((scene) => {
        if (cancelled) return;
        sceneRef.current = scene;
        (window as unknown as Record<string, unknown>).__aetherScene = scene;
        const envLabel =
          scene.environmentMode === 'synthetic'
            ? 'Synthetic IBL'
            : environmentMode === 'relax_inn'
              ? 'Relax Inn 4K HDR'
              : 'Venice Sunset HDR';
        const bgLabel = scene.backgroundMode ? ` + ${scene.backgroundMode} bg` : '';
        setStatus({
          kind: 'ready',
          message: `Rendering with ${scene.backend} (${envLabel}${bgLabel})`
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const isCancelled = error instanceof Error && error.message.includes('cancelled');
        if (!isCancelled) {
          setStatus({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Unable to start the renderer.'
          });
        }
      });

    return () => {
      cancelled = true;
      sceneRef.current = null;
      void host.unmount();
    };
  }, [mountScene, environmentMode, backgroundMode]);

  return (
    <div className="demo-content">
      <LevaPanel
        store={store}
        hidden={
          typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e')
        }
        collapsed={false}
        oneLineLabels
        titleBar={{ title: 'Aether CSM Controls' }}
      />
      <section className="demo-shell" aria-label="Aether Engine rendering example">
        <canvas ref={canvas} aria-label="Standard-lit three-dimensional box" />
        <p className={`status status-${status.kind}`} role="status" aria-live="polite">
          {status.message}
        </p>
      </section>
    </div>
  );
}
