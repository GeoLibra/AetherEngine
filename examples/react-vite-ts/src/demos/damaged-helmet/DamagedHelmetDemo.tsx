import { useEffect, useRef, useState } from 'react';
import { LevaPanel, useControls, folder, useCreateStore } from 'leva';
import {
  mountDamagedHelmetScene,
  type MountedDamagedHelmetScene,
  type DamagedHelmetDiagnostics,
  type DamagedHelmetSceneOptions
} from './damaged-helmet-scene';
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

const IS_E2E =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('e2e');

export function DamagedHelmetDemo({ mountScene = true }: DemoProps) {
  const store = useCreateStore();
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<MountedDamagedHelmetScene | null>(null);
  const hostRef = useRef<AetherSceneHost<
    MountedDamagedHelmetScene,
    DamagedHelmetSceneOptions
  > | null>(null);
  if (hostRef.current === null) {
    hostRef.current = new AetherSceneHost(mountDamagedHelmetScene);
  }
  const [status, setStatus] = useState<Status>({
    kind: 'loading',
    message: 'Loading DamagedHelmet glTF PBR model…'
  });
  const [modelDiag, setModelDiag] = useState<DamagedHelmetDiagnostics | null>(null);

  // Leva controls
  const [
    {
      castsShadow,
      sunlight,
      lightAngle,
      environmentMode,
      environmentIntensity,
      backgroundMode,
      backgroundMultiplier,
      animate,
      manualRotation
    }
  ] = useControls(
    () => ({
      'Environment & Lighting': folder({
        environmentMode: {
          value: 'relax_inn',
          options: {
            'Relax Inn Seaview (4K HDR)': 'relax_inn',
            'Venice Sunset (1K HDR)': 'venice_sunset',
            'Synthetic Fallback': 'synthetic'
          },
          label: 'Environment IBL'
        },
        environmentIntensity: {
          value: 1.0,
          min: 0.1,
          max: 3.0,
          step: 0.1,
          label: 'IBL Intensity'
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
        sunlight: { value: true, label: 'Sunlight (15k Lux)' },
        castsShadow: { value: true, label: 'Cast Shadows' },
        lightAngle: { value: 65, min: 0, max: 360, step: 1, label: 'Light Azimuth (°)' }
      }),
      'Model & Display': folder({
        animate: { value: !IS_E2E, label: 'Auto-Rotate' },
        manualRotation: { value: 0, min: -180, max: 180, step: 1, label: 'Manual Rotation (°)' }
      })
    }),
    { store },
    []
  );

  // Sync real-time controls into the active scene
  useEffect(() => {
    if (!sceneRef.current) return;
    sceneRef.current.setCastsShadow(castsShadow);
    sceneRef.current.setSunlight(sunlight);
    sceneRef.current.setBackgroundMultiplier(backgroundMultiplier);
    sceneRef.current.setEnvironmentIntensity(environmentIntensity);
    const rad = (lightAngle * Math.PI) / 180;
    sceneRef.current.setLightDirection([Math.cos(rad) * -0.7, -1, Math.sin(rad) * -0.7]);
    sceneRef.current.setAnimate(animate);
    if (!animate) {
      sceneRef.current.setRotation((manualRotation * Math.PI) / 180);
    }
  }, [
    castsShadow,
    sunlight,
    lightAngle,
    backgroundMultiplier,
    environmentIntensity,
    animate,
    manualRotation
  ]);

  // Mount DamagedHelmet scene via serialized lifecycle host
  useEffect(() => {
    if (!mountScene) return;
    const target = canvas.current;
    if (target === null) return;
    const host = hostRef.current!;
    let cancelled = false;

    setStatus({
      kind: 'loading',
      message: 'Cooking DamagedHelmet glTF & generating MikkTSpace tangents…'
    });

    void host
      .mount(target, {
        ...(STATIC_BACKEND_PREFERENCE ? { preference: STATIC_BACKEND_PREFERENCE } : {}),
        animate,
        environment: environmentMode as any,
        environmentIntensity,
        background: backgroundMode as 'hdr' | 'solid' | 'none',
        backgroundMultiplier,
        sunlight
      })
      .then((scene) => {
        if (cancelled) return;
        sceneRef.current = scene;
        (window as unknown as Record<string, unknown>).__damagedHelmetScene = Object.freeze({
          state: () => ({
            backend: scene.backend,
            environmentMode: scene.environmentMode,
            backgroundMode: scene.backgroundMode,
            diagnostics: scene.diagnostics(),
            modelDiagnostics: scene.modelDiagnostics(),
            nativeMetrics: scene.nativeMetrics(),
            nativeError: scene.nativeError(),
            validationErrors: scene.validationErrors(),
            runtimeErrors: scene.runtimeErrors()
          }),
          resize: (width: number, height: number) => scene.resize(width, height),
          setRotation: (angleRadians: number | null) => scene.setRotation(angleRadians),
          setAnimate: (enabled: boolean) => scene.setAnimate(enabled),
          destroy: () => scene.destroy()
        });
        const diag = scene.modelDiagnostics();
        setModelDiag(diag);
        setStatus({
          kind: 'ready',
          message: `Rendering glTF PBR with ${scene.backend} (14.5k vertices, 5 PBR textures)`
        });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const isCancelled = error instanceof Error && error.message.includes('cancelled');
        if (!isCancelled) {
          const msg = error instanceof Error ? error.message : String(error);
          setStatus({
            kind: 'error',
            message: `glTF PBR error: ${msg}`
          });
        }
      });

    return () => {
      cancelled = true;
      sceneRef.current = null;
      (window as unknown as Record<string, unknown>).__damagedHelmetScene = undefined;
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
        titleBar={{ title: 'DamagedHelmet PBR Controls' }}
      />
      <section className="demo-shell" aria-label="Aether glTF DamagedHelmet rendering example">
        <canvas ref={canvas} aria-label="DamagedHelmet glTF Metallic-Roughness PBR mesh" />
        <div className="status-overlay">
          <p className={`status status-${status.kind}`} role="status" aria-live="polite">
            {status.message}
          </p>
          {modelDiag && (
            <div className="model-badges">
              <span className="badge">Vertices: {modelDiag.vertexCount.toLocaleString()}</span>
              <span className="badge">
                Triangles: {(modelDiag.indexCount / 3).toLocaleString()}
              </span>
              <span className="badge">Tangents: MikkTSpace</span>
              <span className="badge">Textures: 5 Slots (Base, MR, Norm, AO, Emiss)</span>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
