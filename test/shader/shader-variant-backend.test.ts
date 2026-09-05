import { describe, expect, test } from 'vitest';
import { emitShaderBackend } from '../../src/shader/experimental/flux/backends';
import {
  resolveShaderVariants,
  type ShaderFunctionId,
  type ShaderModuleIR,
  type ShaderTypeId,
  type ShaderVariantDimension
} from '../../src/shader';
import type { WebGL2ShaderTranslationPort } from '../../src';

const dimensions: ShaderVariantDimension[] = [
  { name: 'USE_FOG', kind: 'boolean', fallback: false },
  { name: 'QUALITY', kind: 'enum', values: ['low', 'high'], fallback: 'low' },
  {
    name: 'PATH',
    kind: 'enum',
    values: ['forward', 'deferred'],
    fallback: 'forward',
    requires: { deferred: ['storage-buffer'] }
  }
];

const ir: ShaderModuleIR = Object.freeze({
  version: 1,
  types: [],
  globals: [],
  functions: [],
  entryPoints: [
    {
      id: 1 as ShaderFunctionId,
      name: 'main',
      stage: 'vertex' as const,
      parameters: [],
      body: [],
      span: { uri: 'asset://main.flux', line: 1, column: 1, length: 10 }
    }
  ],
  variants: dimensions,
  sourceMap: { spans: [] },
  sourceClosureHash: 'closure'
});

describe('shader variants and backend output', () => {
  test('normalizes order-independent variants and applies typed fallback', () => {
    const first = resolveShaderVariants(dimensions, { QUALITY: 'high', USE_FOG: true }, new Set());
    const second = resolveShaderVariants(dimensions, { USE_FOG: true, QUALITY: 'high' }, new Set());
    expect(first.ok && second.ok && first.key.value).toBe(second.ok && second.key.value);
    expect(first.ok && first.values.PATH).toBe('forward');
  });

  test('returns structured errors for invalid values and missing capabilities', () => {
    expect(resolveShaderVariants(dimensions, { QUALITY: 'ultra' }, new Set())).toMatchObject({
      ok: false,
      error: { code: 'VARIANT_INVALID_VALUE' }
    });
    expect(resolveShaderVariants(dimensions, { PATH: 'deferred' }, new Set())).toMatchObject({
      ok: false,
      error: { code: 'VARIANT_CAPABILITY_REQUIRED' }
    });
  });

  test('emits typed backend source in valid directive order and requires validation', async () => {
    const variants = resolveShaderVariants(
      dimensions,
      { QUALITY: 'high', USE_FOG: true },
      new Set()
    );
    if (!variants.ok) throw new Error('Expected variants');
    const validator = {
      validate: async ({ source }: { source: string }) =>
        source.includes('INVALID') ? [{ line: 2, column: 1, message: 'invalid' }] : []
    };
    const glsl = await emitShaderBackend(ir, {
      target: 'glsl300es',
      variants,
      approvedExtensions: ['GL_EXT_draw_buffers'],
      translator: translator(['GL_EXT_draw_buffers']),
      validator
    });
    expect(glsl.ok).toBe(true);
    if (glsl.ok) {
      const lines = glsl.source.split('\n');
      expect(lines[0]).toBe('#version 300 es');
      expect(lines[1]).toContain('#extension GL_EXT_draw_buffers');
      expect(lines.findIndex((line: string) => line.startsWith('#define'))).toBeGreaterThan(1);
      expect(glsl.source).toContain('void main()');
      expect(glsl.source).not.toMatch(/@vertex|\bfn\b/);
    }
  });

  test('maps validator exceptions to backend diagnostics', async () => {
    const variants = resolveShaderVariants(dimensions, {}, new Set());
    if (!variants.ok) throw new Error('Expected variants');
    const result = await emitShaderBackend(ir, {
      target: 'wgsl',
      variants,
      validator: {
        validate: async () => {
          throw new Error('driver rejected module');
        }
      }
    });
    expect(result).toMatchObject({
      ok: false,
      diagnostics: [{ code: 'SHADER_BACKEND_EXCEPTION', backendLog: 'driver rejected module' }]
    });
  });

  test('uses the typed GLSL emitter by default and rejects translator-owned directives', async () => {
    const variants = resolveShaderVariants(dimensions, {}, new Set());
    if (!variants.ok) throw new Error('Expected variants');
    const validator = { validate: async () => [] };

    const typed = await emitShaderBackend(ir, { target: 'glsl300es', variants, validator });
    expect(typed).toMatchObject({ ok: true });
    if (typed.ok) {
      expect(typed.source).toContain('// Aether typed GLSL ES emitter 1');
      expect(typed.source).toContain('void main()');
    }

    const invalid = translator();
    invalid.translate = () => ({
      source: '#version 300 es\nvoid main() {}',
      bindings: [],
      targetAbiFingerprint: 'test-abi',
      physicalBindings: [],
      programBindings: [],
      requiredExtensions: [],
      sourceMap: [],
      translatorFingerprint: 'bad-directive'
    });
    await expect(
      emitShaderBackend(ir, {
        target: 'glsl300es',
        variants,
        validator,
        translator: invalid
      })
    ).resolves.toMatchObject({
      ok: false,
      diagnostics: [{ code: 'SHADER_TRANSLATION_FAILED' }]
    });
  });

  test('rejects unapproved extensions and incomplete physical binding manifests', async () => {
    const variants = resolveShaderVariants(dimensions, {}, new Set());
    if (!variants.ok) throw new Error('Expected variants');
    const validator = { validate: async () => [] };

    await expect(
      emitShaderBackend(ir, {
        target: 'glsl300es',
        variants,
        validator,
        translator: translator(['GL_EXT_unapproved'])
      })
    ).resolves.toMatchObject({ ok: false, diagnostics: [{ code: 'SHADER_TRANSLATION_FAILED' }] });

    const incomplete = translator();
    incomplete.translate = () => ({
      source: 'void main() {}',
      bindings: [{ group: 0, binding: 0, name: 'Frame', kind: 'uniform-buffer' }],
      targetAbiFingerprint: 'test-abi',
      physicalBindings: [],
      programBindings: [],
      requiredExtensions: [],
      sourceMap: [],
      translatorFingerprint: 'missing-slot'
    });
    await expect(
      emitShaderBackend(ir, {
        target: 'glsl300es',
        variants,
        validator,
        translator: incomplete
      })
    ).resolves.toMatchObject({ ok: false, diagnostics: [{ code: 'SHADER_TRANSLATION_FAILED' }] });
  });

  test('emits WGSL type, global and helper declarations before selected entries', async () => {
    const variants = resolveShaderVariants(dimensions, {}, new Set());
    if (!variants.ok) throw new Error('Expected variants');
    const module: ShaderModuleIR = {
      ...ir,
      types: [
        {
          kind: 'struct',
          name: 'Camera',
          fields: [{ name: 'viewProj', type: 'mat4x4<f32>' }]
        }
      ],
      globals: [
        {
          name: 'camera',
          type: 'Camera',
          addressSpace: 'uniform',
          access: 'read',
          group: 0,
          binding: 0,
          span: { uri: 'asset://main.flux', line: 1, column: 1, length: 1 }
        }
      ],
      functions: [
        {
          id: 2 as ShaderFunctionId,
          name: 'helper',
          parameters: [],
          returnType: 'f32' as ShaderTypeId,
          body: [
            {
              kind: 'return',
              value: {
                kind: 'literal',
                value: 1,
                type: 'f32' as ShaderTypeId,
                span: { uri: 'asset://main.flux', line: 2, column: 1, length: 1 }
              },
              span: { uri: 'asset://main.flux', line: 2, column: 1, length: 1 }
            }
          ],
          span: { uri: 'asset://main.flux', line: 2, column: 1, length: 1 }
        }
      ]
    };

    const result = await emitShaderBackend(module, {
      target: 'wgsl',
      variants,
      validator: { validate: async () => [] }
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source).toContain('struct Camera');
    expect(result.source).toContain('@group(0) @binding(0) var<uniform> camera: Camera;');
    expect(result.source).toContain('fn helper() -> f32');
    expect(result.source.indexOf('struct Camera')).toBeLessThan(result.source.indexOf('fn main'));
  });
});

function translator(requiredExtensions: readonly string[] = []): WebGL2ShaderTranslationPort {
  return {
    translatorId: 'test-translator',
    version: 1,
    translate: () => ({
      source: 'void main() {}',
      bindings: [],
      targetAbiFingerprint: 'test-abi',
      physicalBindings: [],
      programBindings: [],
      requiredExtensions,
      sourceMap: [],
      translatorFingerprint: 'test-output'
    })
  };
}
