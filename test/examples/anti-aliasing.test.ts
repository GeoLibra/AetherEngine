import { describe, expect, test } from 'vitest';
import {
  DemoAntiAliasing,
  demoAntiAliasingNotice,
  resolveDemoSampleCount
} from '../../examples/react-vite-ts/src/anti-aliasing';

describe('demo anti-aliasing selection', () => {
  test('enables only the implemented 4x MSAA mode', () => {
    expect(resolveDemoSampleCount(DemoAntiAliasing.None)).toBe(1);
    expect(resolveDemoSampleCount(DemoAntiAliasing.Msaa4)).toBe(4);
  });

  test('keeps planned post-process modes observable without enabling them', () => {
    expect(resolveDemoSampleCount(DemoAntiAliasing.Taa)).toBe(1);
    expect(resolveDemoSampleCount(DemoAntiAliasing.Fxaa)).toBe(1);
    expect(demoAntiAliasingNotice(DemoAntiAliasing.Taa)).toMatch(/planned/);
    expect(demoAntiAliasingNotice(DemoAntiAliasing.Fxaa)).toMatch(/planned/);
  });
});
