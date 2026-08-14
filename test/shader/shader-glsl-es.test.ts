import { describe, expect, test } from 'vitest';

import {
  emitGlslEsModule,
  type ShaderFunctionId,
  type ShaderModuleIR,
  type ShaderSymbolId,
  type ShaderTypeId
} from '../../src/shader';

const span = { uri: 'asset://shader.flux', line: 1, column: 1, length: 1 };

describe('typed GLSL ES emitter', () => {
  test('lowers vertex inputs, uniform blocks, and position output', () => {
    const position = 1 as ShaderSymbolId;
    const ir: ShaderModuleIR = {
      version: 1,
      types: [
        { kind: 'struct', name: 'Camera', fields: [{ name: 'viewProj', type: 'mat4x4<f32>' }] }
      ],
      globals: [
        {
          name: 'camera',
          type: 'Camera',
          addressSpace: 'uniform',
          access: 'read',
          group: 0,
          binding: 0,
          span
        }
      ],
      functions: [],
      entryPoints: [
        {
          id: 1 as ShaderFunctionId,
          name: 'vsMain',
          stage: 'vertex',
          parameters: [
            { id: position, name: 'position', type: 'vec4<f32>' as ShaderTypeId, location: 0, span }
          ],
          returnType: 'vec4<f32>' as ShaderTypeId,
          body: [
            {
              kind: 'return',
              value: {
                kind: 'symbol',
                symbol: position,
                name: 'position',
                type: 'vec4<f32>' as ShaderTypeId,
                span
              },
              span
            }
          ],
          span
        }
      ],
      variants: [],
      sourceMap: { spans: [] },
      sourceClosureHash: 'fixture'
    };
    const source = emitGlslEsModule(ir, 'vsMain');
    expect(source).toContain('layout(std140) uniform Aether_0_0');
    expect(source).toContain('layout(location = 0) in vec4 position;');
    expect(source).toContain('gl_Position = position;');
    expect(source).toContain('void main()');
    expect(source).not.toMatch(/@vertex|\bfn\b/);
  });

  test('lowers fragment return to a declared output', () => {
    const value = {
      kind: 'construct' as const,
      type: 'vec4<f32>' as ShaderTypeId,
      arguments: [0, 1, 0, 1].map((number) => ({
        kind: 'literal' as const,
        value: number,
        type: 'f32' as ShaderTypeId,
        span
      })),
      span
    };
    const ir: ShaderModuleIR = {
      version: 1,
      types: [],
      globals: [],
      functions: [],
      entryPoints: [
        {
          id: 2 as ShaderFunctionId,
          name: 'fsMain',
          stage: 'fragment',
          parameters: [],
          returnType: 'vec4<f32>' as ShaderTypeId,
          returnLocation: 0,
          body: [{ kind: 'return', value, span }],
          span
        }
      ],
      variants: [],
      sourceMap: { spans: [] },
      sourceClosureHash: 'fixture'
    };
    const source = emitGlslEsModule(ir, 'fsMain');
    expect(source).toContain('layout(location = 0) out vec4 aether_fragment_output;');
    expect(source).toContain('aether_fragment_output = vec4(0.0, 1.0, 0.0, 1.0);');
  });
});
