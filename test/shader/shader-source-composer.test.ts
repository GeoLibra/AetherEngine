import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const cargo = process.env.CARGO ?? 'cargo';
const pinnedCargo = spawnSync(cargo, ['+1.95.0', '--version'], { encoding: 'utf8' });
const hasPinnedCargo = pinnedCargo.status === 0;

import {
  composeWgslFragments,
  mapComposedLocation,
  NativeCookerError,
  NativeWgslCooker,
  remapCookerError,
  type SourceFragmentInput
} from '../../tools/shader-cooker';

describe('WGSL source composer and diagnostic remapping', () => {
  test('composes source fragments and records accurate line intervals', () => {
    const fragments: readonly SourceFragmentInput[] = [
      {
        path: 'src/shader/segment-a.wgsl',
        content: ['struct Header {', '  count: u32,', '};'].join('\n')
      },
      {
        path: 'src/shader/segment-b.wgsl',
        content: [
          '@vertex',
          'fn vsMain() -> @builtin(position) vec4f {',
          '  return vec4f(0.0);',
          '}'
        ].join('\n')
      }
    ];

    const result = composeWgslFragments(fragments);

    expect(result.segments).toHaveLength(2);

    // Fragment A:
    // Line 1: // --- Source Fragment: src/shader/segment-a.wgsl ---
    // Line 2: struct Header {
    // Line 3:   count: u32,
    // Line 4: };
    expect(result.segments[0]).toEqual({
      path: 'src/shader/segment-a.wgsl',
      startLine: 2,
      endLine: 4,
      lineCount: 3
    });

    // Separator line 5: ''
    // Line 6: // --- Source Fragment: src/shader/segment-b.wgsl ---
    // Line 7: @vertex
    // Line 8: fn vsMain() -> @builtin(position) vec4f {
    // Line 9:   return vec4f(0.0);
    // Line 10: }
    expect(result.segments[1]).toEqual({
      path: 'src/shader/segment-b.wgsl',
      startLine: 7,
      endLine: 10,
      lineCount: 4
    });

    const lines = result.composedSource.split('\n');
    expect(lines[1]).toBe('struct Header {');
    expect(lines[6]).toBe('@vertex');
  });

  test('maps composed line numbers back to original source file and relative lines', () => {
    const fragments: readonly SourceFragmentInput[] = [
      {
        path: 'first.wgsl',
        content: 'line 1\nline 2\nline 3'
      },
      {
        path: 'second.wgsl',
        content: 'alpha\nbeta\ngamma\ndelta'
      }
    ];

    const { segments } = composeWgslFragments(fragments);

    // Segment 1 boundary and middle
    expect(mapComposedLocation(2, segments, 5)).toEqual({
      path: 'first.wgsl',
      line: 1,
      column: 5
    });
    expect(mapComposedLocation(3, segments, 1)).toEqual({
      path: 'first.wgsl',
      line: 2,
      column: 1
    });
    expect(mapComposedLocation(4, segments)).toEqual({
      path: 'first.wgsl',
      line: 3,
      column: undefined
    });

    // Segment 2 boundary and middle
    expect(mapComposedLocation(7, segments, 8)).toEqual({
      path: 'second.wgsl',
      line: 1,
      column: 8
    });
    expect(mapComposedLocation(8, segments, 12)).toEqual({
      path: 'second.wgsl',
      line: 2,
      column: 12
    });
    expect(mapComposedLocation(10, segments, 2)).toEqual({
      path: 'second.wgsl',
      line: 4,
      column: 2
    });

    // Out of bounds
    expect(mapComposedLocation(1, segments)).toBeUndefined(); // banner
    expect(mapComposedLocation(5, segments)).toBeUndefined(); // separator
    expect(mapComposedLocation(99, segments)).toBeUndefined();
  });

  test('remaps NativeCookerError diagnostic to original fragment path and line', () => {
    const fragments: readonly SourceFragmentInput[] = [
      {
        path: 'src/shader/light-access.wgsl',
        content: 'struct LightData { val: u32, };'
      },
      {
        path: 'src/shader/shading.wgsl',
        content: ['@vertex', 'fn vsMain() {', '  let x = 1;', '}'].join('\n')
      }
    ];

    const { segments } = composeWgslFragments(fragments);

    // Suppose Naga reports an error at composed line 6 (fn vsMain()) column 4
    const originalError = new NativeCookerError('wgsl-parse-failed: expected type, found "{"', {
      code: 'wgsl-parse-failed',
      sourceUri: 'asset://composed.wgsl',
      rawStderr: '{"code":"wgsl-parse-failed","line":6,"column":4}',
      line: 6,
      column: 4,
      backendStage: 'parse'
    });

    const remapped = remapCookerError(originalError, segments);

    expect(remapped).toBeInstanceOf(NativeCookerError);
    const cookerError = remapped as NativeCookerError;
    expect(cookerError.sourceUri).toBe('src/shader/shading.wgsl');
    expect(cookerError.line).toBe(2); // line 2 of shading.wgsl (fn vsMain())
    expect(cookerError.column).toBe(4);
    expect(cookerError.message).toContain('[src/shader/shading.wgsl:2:4]');
  });

  test.skipIf(!hasPinnedCargo)(
    'live Naga compilation error localization maps to the second fragment',
    async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'aether-test-composer-'));

      try {
        const fragments: readonly SourceFragmentInput[] = [
          {
            path: 'src/shader/builtins/standard-lit-list/webgpu/light-access.wgsl',
            content: ['struct PackedHeader {', '  offset: u32,', '  count: u32,', '};'].join('\n')
          },
          {
            path: 'src/shader/builtins/standard-lit-list/shading.wgsl',
            content: [
              '@vertex',
              'fn standardLitVertex( -> @builtin(position) vec4f {',
              '  return vec4f(0.0);',
              '}'
            ].join('\n')
          }
        ];

        const { composedSource, segments } = composeWgslFragments(fragments);
        const composedFile = join(tempDir, 'composed.wgsl');
        await writeFile(composedFile, composedSource, 'utf8');

        const cooker = new NativeWgslCooker();
        let caughtError: unknown;

        try {
          await cooker.cook({
            sourcePath: composedFile,
            sourceUri: 'asset://test/composed.wgsl'
          });
        } catch (err: unknown) {
          caughtError = err;
        }

        expect(caughtError).toBeInstanceOf(NativeCookerError);

        const remapped = remapCookerError(caughtError, segments) as NativeCookerError;

        // The error in shading.wgsl is on line 2 (`fn standardLitVertex( -> ...`)
        expect(remapped.sourceUri).toBe('src/shader/builtins/standard-lit-list/shading.wgsl');
        expect(remapped.line).toBe(2);
        expect(remapped.message).toContain('src/shader/builtins/standard-lit-list/shading.wgsl:2');
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    120_000
  );
});
