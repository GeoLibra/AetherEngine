import { describe, expect, test } from 'vitest';

import {
  collectGlslTextureSamplerUses,
  fuseGlslTextureSamplerBindings
} from '../../src/shader/backends/glsl-binding-fusion';
import type {
  ShaderBindingEntryManifest,
  ShaderFunctionId,
  ShaderModuleIR,
  ShaderSymbolId,
  ShaderTypeId
} from '../../src/shader';

const bindings: ShaderBindingEntryManifest[] = [
  {
    kind: 'texture',
    group: 0,
    binding: 0,
    name: 'albedo',
    viewDimension: '2d',
    sampleType: 'float',
    multisampled: false
  },
  {
    kind: 'texture',
    group: 0,
    binding: 1,
    name: 'environment',
    viewDimension: 'cube',
    sampleType: 'float',
    multisampled: false
  },
  { kind: 'sampler', group: 0, binding: 2, name: 'linear', samplerType: 'filtering' },
  { kind: 'sampler', group: 0, binding: 3, name: 'nearest', samplerType: 'non-filtering' }
];

describe('GLSL texture/sampler binding fusion', () => {
  test('allocates deterministic combined slots and merges stage sharing', () => {
    const result = fuseGlslTextureSamplerBindings(
      bindings,
      [
        {
          texture: { group: 0, binding: 1 },
          sampler: { group: 0, binding: 2 },
          stages: ['fragment']
        },
        {
          texture: { group: 0, binding: 0 },
          sampler: { group: 0, binding: 3 },
          stages: ['fragment']
        },
        {
          texture: { group: 0, binding: 0 },
          sampler: { group: 0, binding: 2 },
          stages: ['vertex']
        },
        {
          texture: { group: 0, binding: 0 },
          sampler: { group: 0, binding: 2 },
          stages: ['fragment']
        }
      ],
      8
    );

    expect(result).toEqual([
      expect.objectContaining({
        name: 'aether_t0_0_s0_2',
        slot: 0,
        samplerType: 'sampler2D',
        stages: ['vertex', 'fragment']
      }),
      expect.objectContaining({ name: 'aether_t0_0_s0_3', slot: 1, samplerType: 'sampler2D' }),
      expect.objectContaining({ name: 'aether_t0_1_s0_2', slot: 2, samplerType: 'samplerCube' })
    ]);
  });

  test('rejects slot overflow without aliasing texture units', () => {
    expect(() =>
      fuseGlslTextureSamplerBindings(
        bindings,
        [
          {
            texture: { group: 0, binding: 0 },
            sampler: { group: 0, binding: 2 },
            stages: ['fragment']
          },
          {
            texture: { group: 0, binding: 0 },
            sampler: { group: 0, binding: 3 },
            stages: ['fragment']
          }
        ],
        1
      )
    ).toThrow(/require 2 texture units, limit is 1/i);
  });

  test('discovers textureSample pairs from typed IR instead of source rewriting', () => {
    const texture = 10 as ShaderSymbolId;
    const sampler = 11 as ShaderSymbolId;
    const span = { uri: 'asset://sample.flux', line: 1, column: 1, length: 1 };
    const ir: ShaderModuleIR = {
      version: 1,
      types: [],
      globals: [
        {
          id: texture,
          name: 'albedo',
          type: 'texture_2d<f32>',
          addressSpace: 'handle',
          access: 'read',
          group: 0,
          binding: 0,
          span
        },
        {
          id: sampler,
          name: 'linear',
          type: 'sampler',
          addressSpace: 'handle',
          access: 'read',
          group: 0,
          binding: 2,
          span
        }
      ],
      functions: [],
      entryPoints: [
        {
          id: 1 as ShaderFunctionId,
          name: 'main',
          stage: 'fragment',
          parameters: [],
          returnType: 'vec4<f32>' as ShaderTypeId,
          body: [
            {
              kind: 'return',
              value: {
                kind: 'intrinsic',
                intrinsic: 'textureSample',
                arguments: [
                  {
                    kind: 'symbol',
                    symbol: texture,
                    name: 'albedo',
                    type: 'texture_2d<f32>' as ShaderTypeId,
                    span
                  },
                  {
                    kind: 'symbol',
                    symbol: sampler,
                    name: 'linear',
                    type: 'sampler' as ShaderTypeId,
                    span
                  },
                  { kind: 'construct', type: 'vec2<f32>' as ShaderTypeId, arguments: [], span }
                ],
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
      sourceClosureHash: 'sample'
    };

    expect(collectGlslTextureSamplerUses(ir)).toEqual([
      { texture: { group: 0, binding: 0 }, sampler: { group: 0, binding: 2 }, stages: ['fragment'] }
    ]);
  });
});
