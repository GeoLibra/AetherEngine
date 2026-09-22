import type { DemoDefinition } from './types';
import { CsmBoxDemo } from './csm-box/CsmBoxDemo';
import { DamagedHelmetDemo } from './damaged-helmet/DamagedHelmetDemo';
import { PbrInspectorDemo } from './pbr-inspector/PbrInspectorDemo';

export const DEMO_REGISTRY: readonly DemoDefinition[] = Object.freeze([
  {
    id: 'csm-box',
    path: '/',
    aliases: Object.freeze(['/box', '/csm-box']),
    title: 'CSM Box PBR',
    subtitle: 'Standard-Lit PBR + Real-time CSM',
    description: 'Cascaded Shadow Maps with Venice Sunset HDR IBL and metallic-roughness cube.',
    component: CsmBoxDemo
  },
  {
    id: 'damaged-helmet',
    path: '/damaged-helmet',
    aliases: Object.freeze(['/helmet', '/gltf-damaged-helmet']),
    title: 'Damaged Helmet',
    subtitle: 'glTF 2.0 Static Metallic-Roughness PBR',
    description:
      'Real-world glTF model with 5 PBR texture slots, MikkTSpace tangents, and HDR IBL.',
    component: DamagedHelmetDemo
  },
  {
    id: 'pbr-inspector',
    path: '/pbr-inspector',
    aliases: Object.freeze(['/inspector', '/helmet-inspector']),
    title: 'PBR Inspector',
    subtitle: 'Schema → PowerPanel → Radix',
    description: 'A minimal live-material inspector for the Damaged Helmet glTF example.',
    component: PbrInspectorDemo
  }
]);

export function resolveDemo(pathname: string): DemoDefinition {
  const normalized = pathname.trim().toLowerCase();
  const matched = DEMO_REGISTRY.find(
    (demo) => demo.path === normalized || (demo.aliases && demo.aliases.includes(normalized))
  );
  return matched ?? DEMO_REGISTRY[0]!;
}
