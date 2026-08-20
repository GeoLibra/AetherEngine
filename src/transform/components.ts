import { defineComponent } from '../ecs/component';
import type { LocalTransformView, WorldTransformView } from './types';

/**
 * ECS component representing an entity's local-space translation, rotation, and scale (TRS).
 *
 * Local transform values are authored by gameplay and physics systems. Mutations
 * to these fields trigger reactive dirty-marking to schedule hierarchy matrix propagation.
 */
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

/**
 * ECS component representing an entity's computed world-space transformation matrices.
 *
 * This component is derived entirely at runtime by `TransformRuntime.propagate()`.
 * All fields are marked `runtime-only` as they can be reconstructed deterministically
 * from the scene hierarchy and local transforms.
 */
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
