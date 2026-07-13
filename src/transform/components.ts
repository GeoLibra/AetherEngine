import { defineComponent } from '../ecs/component';
import type { LocalTransformView, WorldTransformView } from './types';

export const LocalTransform = defineComponent<LocalTransformView>({
  id: 'aether.transform.local',
  version: 1,
  name: 'LocalTransform',
  fields: [
    { id: 'translation', name: 'translation', type: 'vec3', compare: 'epsilon' },
    { id: 'rotation', name: 'rotation', type: 'vec4', compare: 'epsilon' },
    { id: 'scale', name: 'scale', type: 'vec3', compare: 'epsilon' },
    {
      id: 'local-version',
      name: 'localVersion',
      type: 'u32',
      serialization: 'runtime-only'
    }
  ]
});

export const WorldTransform = defineComponent<WorldTransformView>({
  id: 'aether.transform.world',
  version: 1,
  name: 'WorldTransform',
  fields: [
    { id: 'matrix', name: 'matrix', type: 'mat4', serialization: 'runtime-only' },
    {
      id: 'previous-matrix',
      name: 'previousMatrix',
      type: 'mat4',
      serialization: 'runtime-only'
    },
    {
      id: 'normal-matrix',
      name: 'normalMatrix',
      type: 'mat3',
      serialization: 'runtime-only'
    },
    {
      id: 'world-version',
      name: 'worldVersion',
      type: 'u32',
      serialization: 'runtime-only'
    },
    {
      id: 'origin-cell',
      name: 'originCell',
      type: 'ivec3',
      serialization: 'runtime-only'
    },
    {
      id: 'determinant-sign',
      name: 'determinantSign',
      type: 'f32',
      serialization: 'runtime-only'
    }
  ]
});
