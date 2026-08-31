import { describe, expect, test } from 'vitest';
import {
  InMemoryShaderSourceResolver,
  parseFluxShader,
  resolveShaderSource,
  normalizeAssetUri
} from '../../src/shader';

describe('FluxSL source and parser', () => {
  test('normalizes asset includes, deduplicates content and preserves references', async () => {
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/main.flux':
        '@include "./common.flux";\n@include "asset://shader/common.flux";\n@vertex fn main() {}',
      'asset://shader/common.flux': 'struct Camera { eye: vec3<f32>, exposure: f32 };'
    });
    const closure = await resolveShaderSource(
      { uri: 'asset://shader/main.flux', languageVersion: 1 },
      resolver
    );

    expect(normalizeAssetUri('./common.flux', 'asset://shader/main.flux')).toBe(
      'asset://shader/common.flux'
    );
    expect(closure.modules).toHaveLength(2);
    expect(closure.references).toHaveLength(2);
    expect(closure.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  test('deduplicates identical include content across different asset URIs', async () => {
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/main.flux': '@include "./a.flux";\n@include "./b.flux";',
      'asset://shader/a.flux': 'struct Shared { value: f32 };',
      'asset://shader/b.flux': 'struct Shared { value: f32 };'
    });
    const closure = await resolveShaderSource(
      { uri: 'asset://shader/main.flux', languageVersion: 1 },
      resolver
    );
    expect(closure.modules).toHaveLength(2);
    expect(closure.references.map((reference) => reference.to)).toEqual([
      'asset://shader/a.flux',
      'asset://shader/b.flux'
    ]);
  });

  test('reports a full include cycle and rejects non-asset paths', async () => {
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/a.flux': '@include "./b.flux";',
      'asset://shader/b.flux': '@include "./c.flux";',
      'asset://shader/c.flux': '@include "./a.flux";'
    });
    await expect(
      resolveShaderSource({ uri: 'asset://shader/a.flux', languageVersion: 1 }, resolver)
    ).rejects.toThrow(
      'a.flux -> asset://shader/b.flux -> asset://shader/c.flux -> asset://shader/a.flux'
    );
    expect(() => normalizeAssetUri('/tmp/private.flux')).toThrow('asset URI');
  });

  test('parses typed structs, bindings, entries and variants into immutable IR', async () => {
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/main.flux': [
        '@variant QUALITY: enum(low, high) = high;',
        'struct Camera { viewProj: mat4x4<f32>, eye: vec3<f32>, exposure: f32 };',
        '@group(0) @binding(0) var<uniform> camera: Camera;',
        '@location(0) var<in> position: vec3<f32>;',
        '@vertex fn vertexMain() {}',
        '@fragment fn fragmentMain() {}'
      ].join('\n')
    });
    const closure = await resolveShaderSource(
      { uri: 'asset://shader/main.flux', languageVersion: 1 },
      resolver
    );
    const result = parseFluxShader(closure);

    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.types).toHaveLength(1);
    expect(result.ir?.globals).toHaveLength(2);
    expect(result.ir?.entryPoints.map((entry) => entry.stage)).toEqual(['vertex', 'fragment']);
    expect(result.ir?.variants[0]).toMatchObject({
      name: 'QUALITY',
      kind: 'enum',
      fallback: 'high'
    });
    expect(Object.isFrozen(result.ir)).toBe(true);
  });

  test('lowers entry point bodies containing nested control flow to typed immutable IR', async () => {
    const source = [
      '@fragment fn fragmentMain() {',
      '  if (true) {',
      '    let color = vec4<f32>(1.0);',
      '  }',
      '  return;',
      '}'
    ].join('\n');
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/nested.flux': source
    });
    const closure = await resolveShaderSource(
      { uri: 'asset://shader/nested.flux', languageVersion: 1 },
      resolver
    );

    const result = parseFluxShader(closure);

    expect(result.diagnostics).toEqual([]);
    const entry = result.ir?.entryPoints[0];
    expect(entry?.body.map((statement) => statement.kind)).toEqual(['if', 'return']);
    expect(entry?.body[0]).toMatchObject({
      kind: 'if',
      condition: { kind: 'literal', value: true }
    });
    expect(() => Object.assign(entry?.body[0] as object, { kind: 'discard' })).toThrow();
    expect(entry?.body[0]).toMatchObject({ kind: 'if' });
  });

  test('returns source-mapped diagnostics for unsupported language and malformed declarations', async () => {
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/bad.flux': 'struct Broken { value vec3<f32> };'
    });
    const closure = await resolveShaderSource(
      { uri: 'asset://shader/bad.flux', languageVersion: 99 },
      resolver
    );
    const result = parseFluxShader(closure);
    expect(result.diagnostics.map((value) => value.code)).toContain('FLUX_UNSUPPORTED_VERSION');
    expect(result.diagnostics[0]?.primary.uri).toBe('asset://shader/bad.flux');
  });

  test('does not silently ignore malformed declarations in a supported language', async () => {
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/malformed.flux': 'struct Broken { value vec3<f32> };'
    });
    const closure = await resolveShaderSource(
      { uri: 'asset://shader/malformed.flux', languageVersion: 1 },
      resolver
    );
    expect(parseFluxShader(closure).diagnostics).toMatchObject([{ code: 'FLUX_MALFORMED_STRUCT' }]);
  });

  test('typechecks referenced types and rejects duplicate resource bindings', async () => {
    const resolver = new InMemoryShaderSourceResolver({
      'asset://shader/types.flux': [
        '@group(0) @binding(1) var<uniform> missing: Missing;',
        '@group(0) @binding(1) var textureA: texture_2d<f32>;',
        '@group(0) @binding(1) var textureB: texture_2d<f32>;',
        '@fragment fn main() {}'
      ].join('\n')
    });
    const closure = await resolveShaderSource(
      { uri: 'asset://shader/types.flux', languageVersion: 1 },
      resolver
    );
    const result = parseFluxShader(closure);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['FLUX_UNKNOWN_TYPE', 'FLUX_DUPLICATE_BINDING'])
    );
  });

  test('lexes comments and literals and honors expression precedence', async () => {
    const result = await parseSource([
      '// leading comment',
      '@fragment fn main() -> @location(0) f32 {',
      '  /* block comment */ let value: f32 = 1.0 + 2.0 * 3.0;',
      '  return value;',
      '}'
    ]);
    expect(result.diagnostics).toEqual([]);
    const declaration = result.ir?.entryPoints[0]?.body[0];
    expect(declaration).toMatchObject({
      kind: 'declare',
      value: {
        kind: 'binary',
        operator: '+',
        right: { kind: 'binary', operator: '*' }
      }
    });
  });

  test('parses typed signatures, calls, member/index expressions and structured statements', async () => {
    const result = await parseSource([
      'struct Payload { values: array<f32, 4>, enabled: bool };',
      'fn twice(value: f32) -> f32 { return value * 2.0; }',
      '@fragment fn main() -> @location(0) f32 {',
      '  var payload: Payload;',
      '  var total: f32 = twice(payload.values[0]);',
      '  if (payload.enabled) { total = total + 1.0; } else { total = 0.0; }',
      '  switch (u32(total)) { case 0u: { total = 1.0; } default: { total = 2.0; } }',
      '  loop { if (total > 4.0) { break; } continuing { total = total + 1.0; } }',
      '  while (total < 8.0) { total = total + 1.0; continue; }',
      '  return total;',
      '}'
    ]);
    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.functions[0]).toMatchObject({ name: 'twice', body: [{ kind: 'return' }] });
    expect(result.ir?.entryPoints[0]?.body.map((statement) => statement.kind)).toEqual([
      'declare',
      'declare',
      'if',
      'switch',
      'loop',
      'while',
      'return'
    ]);
  });

  test('parses entry IO attributes and discard without raw source escape nodes', async () => {
    const result = await parseSource([
      '@fragment fn main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {',
      '  if (uv.x < 0.0) { discard; }',
      '  return vec4<f32>(uv.x, uv.y, 0.0, 1.0);',
      '}'
    ]);
    expect(result.diagnostics).toEqual([]);
    const entry = result.ir?.entryPoints[0];
    expect(entry?.parameters[0]).toMatchObject({ name: 'uv', location: 0 });
    expect(entry?.returnLocation).toBe(0);
    expect(entry).not.toHaveProperty('source');
  });

  test('preserves built-in and location attributes on struct fields used for entry IO', async () => {
    const result = await parseSource([
      'struct VertexOutput {',
      '  @builtin(position) position: vec4<f32>,',
      '  @location(0) normal: vec3<f32>',
      '};',
      '@vertex fn main() -> VertexOutput {',
      '  return VertexOutput(vec4<f32>(0.0), vec3<f32>(0.0));',
      '}'
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.types[0]).toMatchObject({
      fields: [
        { name: 'position', builtin: 'position' },
        { name: 'normal', location: 0 }
      ]
    });
  });

  test.each([
    ['unknown built-in', '@builtin(color) value: vec4<f32>', 'FLUX_UNSUPPORTED_SYNTAX'],
    ['non-numeric location', '@location(primary) value: vec4<f32>', 'FLUX_UNSUPPORTED_SYNTAX']
  ])('rejects %s struct field attributes', async (_name, field, code) => {
    const result = await parseSource([`struct Output { ${field} };`]);

    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  });

  test('types matrix-vector and vector-scalar shader arithmetic', async () => {
    const result = await parseSource([
      '@vertex fn main(',
      '  @location(0) position: vec3<f32>,',
      '  @location(1) normal: vec3<f32>',
      ') -> @builtin(position) vec4<f32> {',
      '  let world: mat4x4<f32> = mat4x4<f32>();',
      '  let transformed = world * vec4<f32>(position, 1.0);',
      '  let scaled = normal * 0.5;',
      '  return transformed + vec4<f32>(scaled, 0.0);',
      '}'
    ]);

    expect(result.diagnostics).toEqual([]);
    expect(result.ir?.entryPoints[0]?.body).toMatchObject([
      { kind: 'declare', type: 'mat4x4<f32>' },
      { kind: 'declare', type: 'vec4<f32>' },
      { kind: 'declare', type: 'vec3<f32>' },
      { kind: 'return', value: { type: 'vec4<f32>' } }
    ]);
  });

  test.each([
    ['unbalanced body', '@fragment fn main() { if (true) { return; }', 'FLUX_UNEXPECTED_EOF'],
    ['unsupported syntax', '@fragment fn main() { for (;;) {} }', 'FLUX_UNSUPPORTED_SYNTAX'],
    ['trailing input', '@fragment fn main() {} nonsense', 'FLUX_UNSUPPORTED_SYNTAX']
  ])('rejects %s and consumes the complete token stream', async (_name, source, code) => {
    const result = await parseSource([source]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  });

  test.each([
    ['unknown symbol', 'return missing;', 'FLUX_UNKNOWN_SYMBOL'],
    [
      'duplicate symbol',
      'let value: f32 = 1.0; let value: f32 = 2.0; return value;',
      'FLUX_DUPLICATE_SYMBOL'
    ],
    ['call argument', 'return helper(true);', 'FLUX_CALL_ARGUMENT_TYPE'],
    ['assignment', 'var value: f32 = 1.0; value = true; return value;', 'FLUX_ASSIGNMENT_TYPE'],
    ['return', 'return true;', 'FLUX_RETURN_TYPE'],
    ['condition', 'if (1.0) { return 1.0; } return 0.0;', 'FLUX_CONDITION_TYPE'],
    ['intrinsic', 'return mystery(1.0);', 'FLUX_UNKNOWN_FUNCTION']
  ])('reports semantic diagnostics for %s errors', async (_name, body, code) => {
    const helper = 'fn helper(value: f32) -> f32 { return value; }';
    const result = await parseSource([
      helper,
      `@fragment fn main() -> @location(0) f32 { ${body} }`
    ]);
    expect(result.ir).toBeUndefined();
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toContain(code);
  });

  test('supports nested lexical shadowing but rejects invalid field and index access', async () => {
    const valid = await parseSource([
      '@fragment fn main() -> @location(0) f32 {',
      '  let value: f32 = 1.0;',
      '  if (true) { let value: f32 = 2.0; }',
      '  return value;',
      '}'
    ]);
    expect(valid.diagnostics).toEqual([]);

    const invalid = await parseSource([
      'struct Payload { value: f32 };',
      '@fragment fn main() -> @location(0) f32 {',
      '  var payload: Payload;',
      '  let missing = payload.nope;',
      '  return payload.value[true];',
      '}'
    ]);
    expect(invalid.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['FLUX_UNKNOWN_FIELD', 'FLUX_NOT_INDEXABLE'])
    );
  });

  test('validates global address-space/access combinations and entry signatures', async () => {
    const result = await parseSource([
      'var<uniform, read_write> badUniform: f32;',
      '@compute fn computeMain(@location(0) value: f32) -> f32 { return value; }'
    ]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(['FLUX_INVALID_ACCESS', 'FLUX_INVALID_ENTRY_SIGNATURE'])
    );
  });
});

async function parseSource(lines: readonly string[]) {
  const uri = 'asset://shader/corpus.flux';
  const resolver = new InMemoryShaderSourceResolver({ [uri]: lines.join('\n') });
  const closure = await resolveShaderSource({ uri, languageVersion: 1 }, resolver);
  return parseFluxShader(closure);
}
