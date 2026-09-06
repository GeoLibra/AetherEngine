export type BrowserGraphicsBackend = 'webgpu' | 'webgl2';

const LINUX_SOFTWARE_GRAPHICS_ARGS = Object.freeze([
  '--use-angle=vulkan',
  '--enable-features=Vulkan',
  '--use-vulkan=swiftshader',
  '--disable-vulkan-surface',
  '--ignore-gpu-blocklist'
] as const);

const DETERMINISTIC_FRAME_CADENCE_ARGS = Object.freeze([
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows'
] as const);

/** Returns deterministic browser graphics flags for the selected backend and host platform. */
export function browserGraphicsArgs(
  backend: BrowserGraphicsBackend,
  platform: NodeJS.Platform
): string[] {
  return [
    ...DETERMINISTIC_FRAME_CADENCE_ARGS,
    ...(backend === 'webgpu' ? ['--enable-unsafe-webgpu'] : []),
    ...(platform === 'linux' ? LINUX_SOFTWARE_GRAPHICS_ARGS : [])
  ];
}
