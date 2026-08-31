import { describe, expect, it } from 'vitest';
import { browserGraphicsArgs } from './browser-launch-options';

describe('browserGraphicsArgs', () => {
  it('uses the deterministic Vulkan SwiftShader path for WebGPU on Linux', () => {
    expect(browserGraphicsArgs('webgpu', 'linux')).toEqual([
      '--enable-unsafe-webgpu',
      '--use-angle=vulkan',
      '--enable-features=Vulkan',
      '--use-vulkan=swiftshader',
      '--disable-vulkan-surface',
      '--ignore-gpu-blocklist'
    ]);
  });

  it('does not force the Linux software backend on macOS', () => {
    expect(browserGraphicsArgs('webgpu', 'darwin')).toEqual(['--enable-unsafe-webgpu']);
  });
});
