import { useEffect, useRef, useState } from 'react';
import { Leva, useControls, folder } from 'leva';
import { mountAetherScene, type MountedAetherScene } from './aether-scene';

type Status =
  | Readonly<{ kind: 'loading'; message: string }>
  | Readonly<{ kind: 'ready'; message: string }>
  | Readonly<{ kind: 'error'; message: string }>;

export function App({ mountScene = true }: Readonly<{ mountScene?: boolean }>) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<MountedAetherScene | null>(null);
  const [status, setStatus] = useState<Status>({
    kind: 'loading',
    message: 'Starting Aether Engine…'
  });

  // Leva controls
  const [{ castsShadow, lightAngle, shadowDistance }] = useControls(
    () => ({
      'Shadow Settings': folder({
        castsShadow: { value: true, label: 'Cast Shadows' },
        lightAngle: { value: 45, min: 0, max: 360, step: 1, label: 'Light Azimuth (°)' },
        shadowDistance: { value: 25, min: 5, max: 60, step: 1, label: 'Shadow Dist (m)' }
      })
    }),
    []
  );

  // Sync Leva control updates into the 3D scene
  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.setCastsShadow(castsShadow);
    sceneRef.current.setShadowDistance(shadowDistance);
    const rad = (lightAngle * Math.PI) / 180;
    sceneRef.current.setLightDirection([Math.cos(rad) * -0.7, -1, Math.sin(rad) * -0.7]);
  }, [castsShadow, lightAngle, shadowDistance]);

  // Mount Aether scene
  useEffect(() => {
    if (!mountScene) return;
    const target = canvas.current;
    if (target === null) return;
    let active = true;
    let teardown: (() => Promise<void>) | undefined;

    void mountAetherScene(target)
      .then((scene) => {
        teardown = scene.destroy;
        sceneRef.current = scene;
        if (active) {
          setStatus({ kind: 'ready', message: `Rendering with ${scene.backend}` });
        } else {
          void scene.destroy();
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setStatus({
            kind: 'error',
            message: error instanceof Error ? error.message : 'Unable to start the renderer.'
          });
        }
      });

    return () => {
      active = false;
      sceneRef.current = null;
      void teardown?.();
    };
  }, [mountScene]);

  return (
    <main>
      <Leva collapsed={false} oneLineLabels titleBar={{ title: 'Aether CSM Controls' }} />
      <section className="demo-shell" aria-label="Aether Engine rendering example">
        <header className="demo-header">
          <div className="title-group">
            <h1>Aether Engine PBR & CSM Shadow Demo</h1>
            <span className={`status-badge status-${status.kind}`}>{status.message}</span>
          </div>
        </header>
        <div className="canvas-wrapper">
          <canvas ref={canvas} aria-label="Standard-lit three-dimensional box with CSM shadow" />
        </div>
      </section>
    </main>
  );
}
