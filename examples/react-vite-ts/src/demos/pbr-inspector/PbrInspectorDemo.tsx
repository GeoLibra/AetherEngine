import { useEffect, useMemo, useRef, useState } from 'react';
import { AetherSceneHost } from '../../scene-host';
import type { DemoProps } from '../types';
import {
  mountDamagedHelmetScene,
  type MountedDamagedHelmetScene
} from '../damaged-helmet/damaged-helmet-scene';
import { PowerPanel } from './PowerPanel';
import { RadixSliderField } from './RadixSliderField';
import {
  createPbrInspectorSnapshot,
  derivePbrInspectorGroups,
  PBR_INSPECTOR_SCHEMA,
  type PbrParameterKey
} from './pbr-inspector-schema';

/** Demonstrates Schema declaration → PowerPanel → Radix UI → live PBR material update. */
export function PbrInspectorDemo({ mountScene = true }: DemoProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<MountedDamagedHelmetScene | null>(null);
  const hostRef = useRef<AetherSceneHost<MountedDamagedHelmetScene> | null>(null);
  if (hostRef.current === null) hostRef.current = new AetherSceneHost(mountDamagedHelmetScene);

  const [values, setValues] = useState(createPbrInspectorSnapshot);
  const [status, setStatus] = useState('Loading glTF PBR material…');
  const groups = useMemo(() => derivePbrInspectorGroups(PBR_INSPECTOR_SCHEMA), []);

  useEffect(() => {
    if (!mountScene || canvas.current === null) return;
    const host = hostRef.current!;
    let cancelled = false;
    const unsubscribe = host.subscribe((scene) => {
      sceneRef.current = scene;
    });
    void host
      .mount(canvas.current, { animate: false, environment: 'relax_inn', background: 'hdr' })
      .then((scene) => {
        if (cancelled) return;
        sceneRef.current = scene;
        applyAll(scene, values);
        setStatus(`Ready · ${scene.backend.toUpperCase()} · live material parameters`);
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatus(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
      unsubscribe();
      sceneRef.current = null;
      void host.unmount();
    };
  }, [mountScene]);

  const update = (key: PbrParameterKey, value: number) => {
    setValues((current) => Object.freeze({ ...current, [key]: value }));
    const scene = sceneRef.current;
    if (scene !== null) applyOne(scene, key, value);
  };

  return (
    <div className="demo-content pbr-inspector-demo">
      <section className="pbr-stage" aria-label="Damaged helmet PBR inspector demonstration">
        <canvas ref={canvas} aria-label="Damaged helmet with live editable PBR material" />
        <aside className="pbr-inspector-shell" aria-label="PBR material inspector">
          <div className="pbr-inspector-heading">
            <span className="pbr-eyebrow">AETHER / INSPECTOR MVP</span>
            <h2>Damaged Helmet</h2>
            <p>Schema-derived controls · Radix adapter</p>
          </div>
          <PowerPanel
            groups={groups}
            values={values}
            onValueChange={update}
            renderField={(field, value, onValueChange) => (
              <RadixSliderField field={field} value={value} onValueChange={onValueChange} />
            )}
          />
          <p className="pbr-status" role="status">
            {status}
          </p>
        </aside>
      </section>
    </div>
  );
}

function applyAll(
  scene: MountedDamagedHelmetScene,
  values: Readonly<Record<PbrParameterKey, number>>
) {
  for (const [key, value] of Object.entries(values) as readonly [PbrParameterKey, number][]) {
    applyOne(scene, key, value);
  }
}

function applyOne(scene: MountedDamagedHelmetScene, key: PbrParameterKey, value: number) {
  switch (key) {
    case 'metallic':
      scene.setMetallic(value);
      return;
    case 'roughness':
      scene.setRoughness(value);
      return;
    case 'normalScale':
      scene.setNormalScale(value);
      return;
    case 'occlusionStrength':
      scene.setOcclusionStrength(value);
  }
}
