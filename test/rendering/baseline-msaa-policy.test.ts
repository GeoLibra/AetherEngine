import { describe, expect, test } from 'vitest';
import { NullDevice } from '../../src';
import { resolveBaselineSampleCount } from '../../src/rendering/baseline/baseline-options';

describe('baseline MSAA policy', () => {
  test('selects requested 4x when scene-linear and depth attachments support it', () => {
    const source = new NullDevice().capabilities;
    const formats = new Map(source.formats);
    for (const format of ['rgba16float', 'depth24plus'] as const) {
      const capabilities = formats.get(format)!;
      formats.set(format, Object.freeze({ ...capabilities, sampleCounts: Object.freeze([1, 4]) }));
    }
    const device = new NullDevice({ capabilities: Object.freeze({ ...source, formats }) });

    expect(resolveBaselineSampleCount(device, 4)).toEqual({ sampleCount: 4 });
  });

  test('falls back observably to 1x when either baseline attachment lacks 4x support', () => {
    const source = new NullDevice().capabilities;
    const formats = new Map(source.formats);
    const hdr = formats.get('rgba16float')!;
    formats.set('rgba16float', Object.freeze({ ...hdr, sampleCounts: Object.freeze([1]) }));
    const device = new NullDevice({ capabilities: Object.freeze({ ...source, formats }) });

    expect(resolveBaselineSampleCount(device, 4)).toEqual({
      sampleCount: 1,
      fallbackReason: 'rgba16float does not support sampleCount 4'
    });
  });
});
