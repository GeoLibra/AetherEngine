import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import {
  InMemoryShaderSourceResolver,
  emitWgslModule,
  parseFluxShader,
  resolveShaderSource
} from '../../src/shader';

const runCorpus = process.env.AETHER_NAGA_CORPUS === '1' ? describe : describe.skip;

runCorpus('real Naga shader backend corpus', () => {
  test('validates emitted WGSL and translates a fragment entry to GLSL ES 300', async () => {
    const uri = 'asset://shader/naga-corpus.flux';
    const closure = await resolveShaderSource(
      { uri, languageVersion: 1 },
      new InMemoryShaderSourceResolver({
        [uri]:
          '@fragment fn fragmentMain() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 0.5, 0.25, 1.0); }'
      })
    );
    const parsed = parseFluxShader(closure);
    expect(parsed.diagnostics).toEqual([]);
    if (!parsed.ir) throw new Error('Expected typed shader IR.');

    const directory = mkdtempSync(join(tmpdir(), 'aether-naga-'));
    const file = join(directory, 'generated.wgsl');
    writeFileSync(file, emitWgslModule(parsed.ir), 'utf8');
    try {
      const common = [
        '+1.95.0',
        'run',
        '--quiet',
        '--manifest-path',
        'tools/naga-shader-validator/Cargo.toml',
        '--'
      ];
      expect(
        execFileSync(join(homedir(), '.cargo/bin/cargo'), [...common, 'validate', file], {
          encoding: 'utf8'
        }).trim()
      ).toBe('ok');
      const glsl = execFileSync(
        join(homedir(), '.cargo/bin/cargo'),
        [...common, 'glsl', file, 'fragment', 'fragmentMain'],
        { encoding: 'utf8' }
      );
      expect(glsl).toMatch(/^#version 300 es/);
      expect(glsl).toContain('void main()');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
