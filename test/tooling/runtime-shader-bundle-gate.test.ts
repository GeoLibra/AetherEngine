import { describe, expect, test } from 'vitest';
import {
  checkBundleContent,
  FORBIDDEN_BUNDLE_MARKERS
} from '../../scripts/check-runtime-shader-bundle';

describe('Runtime Shader Bundle Gate', () => {
  test('passes on clean runtime bundles with cooked shader artifact literals', () => {
    const cleanBundle = `
      export const artifact = {
        schemaVersion: 1,
        sourceKind: "wgsl",
        modules: {
          wgsl: "@vertex fn vertexMain() {} @fragment fn fragmentMain() {}",
          glslEs300: { "vertex:vertexMain": "#version 300 es\\nvoid main() {}" }
        }
      };
      export function loadShader() { return artifact; }
    `;

    const violations = checkBundleContent('dist/aether-engine.js', cleanBundle);
    expect(violations).toEqual([]);
  });

  test('detects and rejects forbidden node:child_process marker', () => {
    const dirtyBundle = `
      import { spawn } from "node:child_process";
      export function run() { spawn("cargo"); }
    `;

    const violations = checkBundleContent('dist/aether-engine.js', dirtyBundle);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const markers = violations.map((v) => v.marker);
    expect(markers).toContain('node:child_process');
  });

  test('detects and rejects Naga WASM and Cargo identifiers', () => {
    const dirtyBundle = `
      import "@naga/wasm";
      const manifest = "tools/naga-shader-validator/Cargo.toml";
    `;

    const violations = checkBundleContent('dist/aether-engine.js', dirtyBundle);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const markers = violations.map((v) => v.marker);
    expect(markers).toContain('@naga/wasm');
    expect(markers).toContain('Cargo.toml');
  });

  test('detects and rejects authored shader frontend parser imports', () => {
    const dirtyBundle = `
      import { parseFluxModule } from "src/shader/frontend/parser";
    `;

    const violations = checkBundleContent('dist/aether-engine.js', dirtyBundle);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const markers = violations.map((v) => v.marker);
    expect(markers).toContain('src/shader/frontend/parser');
  });
});
