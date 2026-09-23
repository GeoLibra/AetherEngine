import { useEffect, useMemo, useRef, useState } from 'react';
import { StandardLitMaterialSchema } from '@aether/engine';
import { AetherSceneHost } from '../../scene-host';
import type { DemoProps } from '../types';
import {
  mountDamagedHelmetScene,
  type MountedDamagedHelmetScene
} from '../damaged-helmet/damaged-helmet-scene';
import PowerPanel from './power-panel';
import { RadixSliderField } from './RadixSliderField';
import { createMaterialPanelLayout, createMaterialPanelValue } from './material-power-panel';
import { FieldType } from './power-panel/types';

const EDITABLE_PARAMETER_NAMES = new Set(
  StandardLitMaterialSchema.typeSchema.fields
    .filter((field) => field.editor?.widget === 'slider')
    .map((field) => field.name)
);
const PBR_FIELD_MAP = Object.freeze({ [FieldType.Slider]: RadixSliderField });

/** Demonstrates Schema declaration → PowerPanel → Radix UI → live PBR material update. */
export function PbrInspectorDemo({ mountScene = true }: DemoProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<MountedDamagedHelmetScene | null>(null);
  const hostRef = useRef<AetherSceneHost<MountedDamagedHelmetScene> | null>(null);
  if (hostRef.current === null) hostRef.current = new AetherSceneHost(mountDamagedHelmetScene);

  const [values, setValues] = useState(() =>
    createMaterialPanelValue(StandardLitMaterialSchema.typeSchema)
  );
  const [status, setStatus] = useState('Loading glTF PBR material…');
  const declaration = useMemo(
    () => createMaterialPanelLayout(StandardLitMaterialSchema.typeSchema),
    []
  );

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

  const update = (key: string, value: unknown) => {
    if (!EDITABLE_PARAMETER_NAMES.has(key) || typeof value !== 'number') return;
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
            declaration={declaration}
            fieldMap={PBR_FIELD_MAP}
            value={values}
            onChange={({ path, value }) => update(path, value)}
            rowClassName="pbr-panel-fields"
          />
          <p className="pbr-status" role="status">
            {status}
          </p>
        </aside>
      </section>
    </div>
  );
}

function applyAll(scene: MountedDamagedHelmetScene, values: Readonly<Record<string, unknown>>) {
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'number') continue;
    applyOne(scene, key, value);
  }
}

function applyOne(scene: MountedDamagedHelmetScene, key: string, value: number) {
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
