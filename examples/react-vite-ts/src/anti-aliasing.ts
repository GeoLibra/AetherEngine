/** Demo-facing anti-aliasing modes. Only MSAA is currently backed by the renderer. */
export const DemoAntiAliasing = Object.freeze({
  None: 'none',
  Msaa4: 'msaa-4',
  Taa: 'taa',
  Fxaa: 'fxaa'
} as const);

export type DemoAntiAliasing = (typeof DemoAntiAliasing)[keyof typeof DemoAntiAliasing];

/** Labels shown by the demo configuration panels. */
export const DEMO_ANTI_ALIASING_OPTIONS: Readonly<Record<string, DemoAntiAliasing>> = Object.freeze(
  {
    None: DemoAntiAliasing.None,
    '4× MSAA': DemoAntiAliasing.Msaa4,
    'TAA (planned)': DemoAntiAliasing.Taa,
    'FXAA (planned)': DemoAntiAliasing.Fxaa
  }
);

/** Resolves the currently implemented raster sample count for a demo selection. */
export function resolveDemoSampleCount(mode: DemoAntiAliasing): 1 | 4 {
  return mode === DemoAntiAliasing.Msaa4 ? 4 : 1;
}

/** Explains selections that are intentionally present in the UI but not implemented yet. */
export function demoAntiAliasingNotice(mode: DemoAntiAliasing): string | undefined {
  if (mode === DemoAntiAliasing.Taa) return 'TAA is planned; rendering without anti-aliasing.';
  if (mode === DemoAntiAliasing.Fxaa) return 'FXAA is planned; rendering without anti-aliasing.';
  return undefined;
}
