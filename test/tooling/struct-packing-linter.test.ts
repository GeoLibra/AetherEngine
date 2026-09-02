import { describe, expect, test } from 'vitest';
import type { CookedShaderBufferLayout, CookedShaderRuntimeArtifact } from '../../src/shader/types';
import {
  diagnoseStructLayout,
  diagnoseShaderArtifactLayouts,
  formatStructLayoutDiagnostic
} from '../../tools/shader-cooker/struct-packing-linter';

describe('struct layout diagnostic analyzer', () => {
  test('detects factual internal alignment gaps in a struct with gaps', () => {
    // Layout with gaps:
    // a: f32 (offset 0, size 4) -> 12 bytes gap before vec3
    // b: vec3<f32> (offset 16, size 12)
    // c: f32 (offset 28, size 4)
    // d: vec4<f32> (offset 32, size 16)
    // e: f32 (offset 48, size 4) -> 12 bytes gap before vec4
    // f: vec4<f32> (offset 64, size 16)
    // Total size = 80 bytes
    const layoutWithGaps: CookedShaderBufferLayout = {
      group: 0,
      binding: 0,
      name: 'MaterialData',
      byteSize: 80,
      alignment: 16,
      fields: [
        { path: 'a', offset: 0, size: 4, alignment: 4, typeName: 'f32' },
        { path: 'b', offset: 16, size: 12, alignment: 16, typeName: 'vec3<f32>' },
        { path: 'c', offset: 28, size: 4, alignment: 4, typeName: 'f32' },
        { path: 'd', offset: 32, size: 16, alignment: 16, typeName: 'vec4<f32>' },
        { path: 'e', offset: 48, size: 4, alignment: 4, typeName: 'f32' },
        { path: 'f', offset: 64, size: 16, alignment: 16, typeName: 'vec4<f32>' }
      ]
    };

    const diagnosis = diagnoseStructLayout(layoutWithGaps);
    expect(diagnosis.hasGaps).toBe(true);
    expect(diagnosis.gaps).toHaveLength(2);
    expect(diagnosis.gaps[0]).toEqual({
      beforeField: 'a',
      afterField: 'b',
      offset: 4,
      size: 12
    });
    expect(diagnosis.gaps[1]).toEqual({
      beforeField: 'e',
      afterField: 'f',
      offset: 52,
      size: 12
    });
    expect(diagnosis.totalSize).toBe(80);
    expect(diagnosis.paddingBytes).toBe(24);

    const diagnosticText = formatStructLayoutDiagnostic(diagnosis, 'asset://shaders/test.wgsl');
    expect(diagnosticText).toContain('MaterialData');
    expect(diagnosticText).toContain('[WGSL Struct Layout Diagnostic]');
    expect(diagnosticText).toContain(
      'Total size: 80 bytes (24 padding/gap byte(s) across 2 alignment gap(s))'
    );
    expect(diagnosticText).toContain("12 bytes padding between 'a' and 'b' (offset 4)");
    expect(diagnosticText).toContain("12 bytes padding between 'e' and 'f' (offset 52)");
    expect(diagnosticText).not.toContain('wasted');
    expect(diagnosticText).not.toContain('Warning');
  });

  test('reports zero padding bytes for a perfectly packed struct', () => {
    // DirectionalLightData:
    // direction: vec3<f32> (offset 0, size 12)
    // illuminance: f32 (offset 12, size 4) -> fills 16B slot
    // color: vec3<f32> (offset 16, size 12)
    // padding: f32 (offset 28, size 4)
    // Total size = 32 bytes
    const tightLayout: CookedShaderBufferLayout = {
      group: 0,
      binding: 0,
      name: 'DirectionalLightData',
      byteSize: 32,
      alignment: 16,
      fields: [
        { path: 'direction', offset: 0, size: 12, alignment: 16, typeName: 'vec3<f32>' },
        { path: 'illuminance', offset: 12, size: 4, alignment: 4, typeName: 'f32' },
        { path: 'color', offset: 16, size: 12, alignment: 16, typeName: 'vec3<f32>' },
        { path: 'padding', offset: 28, size: 4, alignment: 4, typeName: 'f32' }
      ]
    };

    const diagnosis = diagnoseStructLayout(tightLayout);
    expect(diagnosis.hasGaps).toBe(false);
    expect(diagnosis.paddingBytes).toBe(0);
    expect(diagnosis.gaps).toHaveLength(0);
  });

  test('reports factual padding for nested struct trailing alignment without assuming waste', () => {
    // Outer struct containing Inner { v: vec3<f32> } and outerScalar: f32.
    // Inner has 16-byte alignment per WGSL ABI, leading to 4-byte padding at offset 12.
    const nestedLayout: CookedShaderBufferLayout = {
      group: 0,
      binding: 0,
      name: 'OuterStruct',
      byteSize: 32,
      alignment: 16,
      fields: [
        { path: 'inner.v', offset: 0, size: 12, alignment: 16, typeName: 'vec3<f32>' },
        { path: 'outerScalar', offset: 16, size: 4, alignment: 4, typeName: 'f32' }
      ]
    };

    const diagnosis = diagnoseStructLayout(nestedLayout);
    expect(diagnosis.hasGaps).toBe(true);
    expect(diagnosis.paddingBytes).toBe(4);
    expect(diagnosis.gaps).toHaveLength(1);
    expect(diagnosis.gaps[0]).toEqual({
      beforeField: 'inner.v',
      afterField: 'outerScalar',
      offset: 12,
      size: 4
    });

    const output = formatStructLayoutDiagnostic(diagnosis);
    expect(output).toContain('[WGSL Struct Layout Diagnostic]');
    expect(output).toContain("4 bytes padding between 'inner.v' and 'outerScalar' (offset 12)");
  });

  test('diagnoseShaderArtifactLayouts filters and returns structures with gaps', () => {
    const mockArtifact = {
      bufferLayouts: [
        {
          group: 0,
          binding: 0,
          name: 'PerfectStruct',
          byteSize: 32,
          alignment: 16,
          fields: [
            { path: 'color', offset: 0, size: 16, alignment: 16, typeName: 'vec4<f32>' },
            { path: 'pos', offset: 16, size: 12, alignment: 16, typeName: 'vec3<f32>' },
            { path: 'scale', offset: 28, size: 4, alignment: 4, typeName: 'f32' }
          ]
        },
        {
          group: 1,
          binding: 0,
          name: 'PaddedStruct',
          byteSize: 48,
          alignment: 16,
          fields: [
            { path: 'roughness', offset: 0, size: 4, alignment: 4, typeName: 'f32' },
            { path: 'tint', offset: 16, size: 16, alignment: 16, typeName: 'vec4<f32>' }
          ]
        }
      ]
    } as unknown as CookedShaderRuntimeArtifact;

    const diagnoses = diagnoseShaderArtifactLayouts(mockArtifact);
    expect(diagnoses).toHaveLength(1);
    expect(diagnoses[0]?.structName).toBe('PaddedStruct');
    expect(diagnoses[0]?.gaps).toHaveLength(1);
    expect(diagnoses[0]?.gaps[0]?.size).toBe(12);
  });
});
