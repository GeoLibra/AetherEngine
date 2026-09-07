import { useEffect, useRef, useState } from 'react';
import { Leva, useControls, folder } from 'leva';
import type { MountedAetherScene } from './aether-scene';
import { AetherSceneHost } from './scene-host';

type Status =
  | Readonly<{ kind: 'loading'; message: string }>
  | Readonly<{ kind: 'ready'; message: string }>
  | Readonly<{ kind: 'error'; message: string }>;

export function App({ mountScene = true }: Readonly<{ mountScene?: boolean }>) {
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
    { castsShadow, sunlight, lightAngle, shadowDistance, environmentMode, metallic, roughness }
  ] = useControls(
    () => ({
      'Environment & Lighting': folder({
        environmentMode: {
          value: 'hdr',
          options: {
            'Venice Sunset (Real HDR)': 'hdr',
            'Synthetic Fallback': 'synthetic'
          },
          label: 'Environment IBL'
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
    const rad = (lightAngle * Math.PI) / 180;
    sceneRef.current.setLightDirection([Math.cos(rad) * -0.7, -1, Math.sin(rad) * -0.7]);
  }, [castsShadow, sunlight, shadowDistance, metallic, roughness, lightAngle]);

  // Mount Aether scene via serialized lifecycle host (only remounts on environment change)
  useEffect(() => {
    if (!mountScene) return;
    const target = canvas.current;
    if (target === null) return;
    const host = hostRef.current!;

    setStatus({
      kind: 'loading',
      message: `Loading ${environmentMode === 'hdr' ? 'Venice Sunset HDR' : 'Synthetic'} environment…`
    });

    void host
      .mount(target, {
        environment: environmentMode as 'hdr' | 'synthetic',
        metallic,
        roughness,
        sunlight
      })
      .then((scene) => {
        sceneRef.current = scene;
        const envLabel = scene.environmentMode === 'hdr' ? 'Venice Sunset HDR' : 'Synthetic IBL';
        setStatus({ kind: 'ready', message: `Rendering with ${scene.backend} (${envLabel})` });
      })
      .catch((error: unknown) => {
        const isCancelled = error instanceof Error && error.message.includes('cancelled');
        if (!isCancelled) {
          setStatus({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Unable to start the renderer.'
          });
        }
      });

    return () => {
      sceneRef.current = null;
      void host.unmount();
    };
  }, [mountScene, environmentMode]);

  return (
    <main>
      <Leva
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
    </main>
  );
}
