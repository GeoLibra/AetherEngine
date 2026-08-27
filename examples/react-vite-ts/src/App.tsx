import { useEffect, useRef, useState } from 'react';
import { mountAetherScene } from './aether-scene';

type Status =
  | Readonly<{ kind: 'loading'; message: string }>
  | Readonly<{ kind: 'ready'; message: string }>
  | Readonly<{ kind: 'error'; message: string }>;

export function App() {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<Status>({
    kind: 'loading',
    message: 'Starting Aether Engine…'
  });

  useEffect(() => {
    const target = canvas.current;
    if (target === null) return;
    let active = true;
    let teardown: (() => Promise<void>) | undefined;

    void mountAetherScene(target)
      .then((scene) => {
        teardown = scene.destroy;
        if (active) setStatus({ kind: 'ready', message: `Rendering with ${scene.backend}` });
        else void scene.destroy();
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
      void teardown?.();
    };
  }, []);

  return (
    <main>
      <section className="demo-shell" aria-label="Aether Engine rendering example">
        <canvas ref={canvas} aria-label="Standard-lit three-dimensional box" />
        <p className={`status status-${status.kind}`} role="status" aria-live="polite">
          {status.message}
        </p>
      </section>
    </main>
  );
}
