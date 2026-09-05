/**
 * @file Declarative registry of built-in ShaderGraph node types, signatures, and stage permissions.
 */

import type {
  ShaderDataType,
  ShaderNodeDefinition,
  ShaderNodeSignature,
  ShaderPortDefinition,
  ShaderStage
} from './types';

function valPort(id: string, name: string, type: ShaderDataType): ShaderPortDefinition {
  return Object.freeze({ id, name, type, kind: 'value' });
}

function texPort(id: string, name: string): ShaderPortDefinition {
  return Object.freeze({ id, name, type: 'texture_2d<f32>', kind: 'texture' });
}

function smpPort(id: string, name: string): ShaderPortDefinition {
  return Object.freeze({ id, name, type: 'sampler', kind: 'sampler' });
}

const ARITHMETIC_TYPES: readonly ShaderDataType[] = Object.freeze([
  'f32',
  'vec2f',
  'vec3f',
  'vec4f',
  'i32',
  'u32'
]);

function createBinarySignatures(): readonly ShaderNodeSignature[] {
  return Object.freeze(
    ARITHMETIC_TYPES.map((t) =>
      Object.freeze({
        inputs: Object.freeze([valPort('left', 'Left', t), valPort('right', 'Right', t)]),
        outputs: Object.freeze([valPort('out', 'Out', t)]),
        stage: 'all' as const
      })
    )
  );
}

function createMultiplySignatures(): readonly ShaderNodeSignature[] {
  const standard = createBinarySignatures();
  const scalarVec: ShaderNodeSignature[] = [
    Object.freeze({
      inputs: Object.freeze([valPort('left', 'Left', 'vec2f'), valPort('right', 'Right', 'f32')]),
      outputs: Object.freeze([valPort('out', 'Out', 'vec2f')]),
      stage: 'all' as const
    }),
    Object.freeze({
      inputs: Object.freeze([valPort('left', 'Left', 'vec3f'), valPort('right', 'Right', 'f32')]),
      outputs: Object.freeze([valPort('out', 'Out', 'vec3f')]),
      stage: 'all' as const
    }),
    Object.freeze({
      inputs: Object.freeze([valPort('left', 'Left', 'vec4f'), valPort('right', 'Right', 'f32')]),
      outputs: Object.freeze([valPort('out', 'Out', 'vec4f')]),
      stage: 'all' as const
    })
  ];
  return Object.freeze([...standard, ...scalarVec]);
}

const NO_PORTS: readonly ShaderPortDefinition[] = Object.freeze([]);

const BUILTIN_NODES: readonly ShaderNodeDefinition[] = Object.freeze([
  Object.freeze({
    kind: 'constant',
    description: 'Emits a constant literal scalar or vector value.',
    signatures: Object.freeze(
      ARITHMETIC_TYPES.concat(['bool']).map((t) =>
        Object.freeze({
          inputs: NO_PORTS,
          outputs: Object.freeze([valPort('out', 'Out', t)]),
          stage: 'all' as const
        })
      )
    )
  }),
  Object.freeze({
    kind: 'parameter',
    description: 'Uniform buffer parameter input.',
    signatures: Object.freeze(
      ARITHMETIC_TYPES.map((t) =>
        Object.freeze({
          inputs: NO_PORTS,
          outputs: Object.freeze([valPort('out', 'Out', t)]),
          stage: 'all' as const
        })
      )
    )
  }),
  Object.freeze({
    kind: 'vertexAttribute',
    description: 'Vertex buffer attribute input. Valid in vertex stage only.',
    signatures: Object.freeze(
      ['vec2f', 'vec3f', 'vec4f', 'f32'].map((t) =>
        Object.freeze({
          inputs: NO_PORTS,
          outputs: Object.freeze([valPort('out', 'Out', t as ShaderDataType)]),
          stage: 'vertex' as const
        })
      )
    )
  }),
  Object.freeze({
    kind: 'fragmentOutput',
    description: 'Fragment color output. Valid in fragment stage only.',
    signatures: Object.freeze([
      Object.freeze({
        inputs: Object.freeze([valPort('color', 'Color', 'vec4f')]),
        outputs: NO_PORTS,
        stage: 'fragment' as const
      })
    ])
  }),
  Object.freeze({
    kind: 'textureSample',
    description: 'Samples a 2D texture with a sampler and UV coordinates in fragment stage.',
    signatures: Object.freeze([
      Object.freeze({
        inputs: Object.freeze([
          texPort('texture', 'Texture'),
          smpPort('sampler', 'Sampler'),
          valPort('uv', 'UV', 'vec2f')
        ]),
        outputs: Object.freeze([valPort('color', 'Color', 'vec4f')]),
        stage: 'fragment' as const
      })
    ])
  }),
  Object.freeze({
    kind: 'add',
    description: 'Adds two scalar or vector values.',
    signatures: createBinarySignatures()
  }),
  Object.freeze({
    kind: 'subtract',
    description: 'Subtracts right value from left value.',
    signatures: createBinarySignatures()
  }),
  Object.freeze({
    kind: 'sub',
    description: 'Alias for subtract.',
    signatures: createBinarySignatures()
  }),
  Object.freeze({
    kind: 'multiply',
    description: 'Multiplies two scalar or vector values.',
    signatures: createMultiplySignatures()
  }),
  Object.freeze({
    kind: 'mul',
    description: 'Alias for multiply.',
    signatures: createMultiplySignatures()
  }),
  Object.freeze({
    kind: 'divide',
    description: 'Divides left value by right value.',
    signatures: createBinarySignatures()
  }),
  Object.freeze({
    kind: 'div',
    description: 'Alias for divide.',
    signatures: createBinarySignatures()
  }),
  Object.freeze({
    kind: 'vec4f_from_vec3f',
    description: 'Explicit conversion: combines vec3f rgb and f32 alpha into vec4f.',
    signatures: Object.freeze([
      Object.freeze({
        inputs: Object.freeze([valPort('rgb', 'RGB', 'vec3f'), valPort('alpha', 'Alpha', 'f32')]),
        outputs: Object.freeze([valPort('out', 'Out', 'vec4f')]),
        stage: 'all' as const
      })
    ])
  })
]);

const NODE_MAP = new Map<string, ShaderNodeDefinition>(BUILTIN_NODES.map((def) => [def.kind, def]));

/**
 * Returns the node definition for a given node kind.
 */
export function getShaderNodeDefinition(kind: string): ShaderNodeDefinition | undefined {
  return NODE_MAP.get(kind);
}

/**
 * Finds a matching signature for a given node kind, input types, and target stage.
 */
export function findMatchingSignature(
  definition: ShaderNodeDefinition,
  providedInputs: Readonly<Record<string, ShaderDataType>>,
  targetStage?: ShaderStage
): ShaderNodeSignature | undefined {
  for (const sig of definition.signatures) {
    if (targetStage !== undefined && sig.stage !== 'all' && sig.stage !== targetStage) {
      continue;
    }
    const reqInputs = sig.inputs;
    if (reqInputs.length !== Object.keys(providedInputs).length) {
      continue;
    }
    let matches = true;
    for (const port of reqInputs) {
      if (providedInputs[port.id] !== port.type) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return sig;
    }
  }
  return undefined;
}
