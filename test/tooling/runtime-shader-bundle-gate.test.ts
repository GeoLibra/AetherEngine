import { describe, expect, test } from 'vitest';
import {
  checkBundleContent,
  checkSourcemapSources,
  FORBIDDEN_BUNDLE_IDENTIFIERS,
  FORBIDDEN_SOURCEMAP_SOURCES
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

  test('detects and rejects compiler function identifiers like parseFluxShader', () => {
    const dirtyBundle = `
      function parseFluxShader(source) { return { ir: {} }; }
      export { parseFluxShader };
    `;

    const violations = checkBundleContent('dist/aether-engine.js', dirtyBundle);
    expect(violations.length).toBeGreaterThanOrEqual(1);
    const markers = violations.map((v) => v.marker);
    expect(markers).toContain('parseFluxShader');
  });

  test('detects and rejects sourcemaps containing forbidden frontend compiler sources', () => {
    const dirtySourcemap = JSON.stringify({
      version: 3,
      sources: [
        'src/app/app.ts',
        'src/shader/frontend/parser.ts',
        'src/shader/pipeline/compiler.ts'
      ],
      mappings: 'AAAA;'
    });

    const violations = checkSourcemapSources('dist/aether-engine.js.map', dirtySourcemap);
    expect(violations.length).toBeGreaterThanOrEqual(2);
    const markers = violations.map((v) => v.marker);
    expect(markers).toContain('src/shader/frontend/');
    expect(markers).toContain('src/shader/pipeline/compiler');
  });

  test('passes on clean sourcemaps containing only runtime engine sources', () => {
    const cleanSourcemap = JSON.stringify({
      version: 3,
      sources: [
        'src/app/app.ts',
        'src/ecs/world.ts',
        'src/shader/authoring.ts',
        'src/shader/artifact.ts',
        'src/shader/pipeline/artifact-loader.ts'
      ],
      mappings: 'AAAA;'
    });

    const violations = checkSourcemapSources('dist/aether-engine.js.map', cleanSourcemap);
    expect(violations).toEqual([]);
  });
});
