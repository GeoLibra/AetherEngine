/**
 * @file Quality gate to verify production runtime browser bundles contain no compiler or tooling payloads.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Identifiers / code patterns that MUST NEVER appear in production engine runtime bundle code.
 */
export const FORBIDDEN_BUNDLE_IDENTIFIERS = Object.freeze([
  'node:child_process',
  'child_process',
  '@naga/wasm',
  'naga.wasm',
  'naga_oil',
  'Cargo.toml',
  'tools/naga-shader-validator',
  'tools/shader-cooker',
  'tools/vite',
  'parseFluxShader',
  'lexFluxSource',
  'lowerFluxModules',
  'typecheckFluxAst',
  'createShaderGraph'
]);

/**
 * Source file paths that MUST NEVER appear in client runtime sourcemaps.
 */
export const FORBIDDEN_SOURCEMAP_SOURCES = Object.freeze([
  'src/shader/frontend/',
  'src/shader/pipeline/compiler',
  'src/shader/pipeline/cook',
  'src/shader/graph/',
  'tools/'
]);

export interface BundleViolation {
  readonly file: string;
  readonly marker: string;
  readonly snippet: string;
}

/**
 * Checks a bundle code string for forbidden tooling / compiler identifiers.
 *
 * @param filePath Path to the bundle file for diagnostic reporting.
 * @param content Text content of the bundle file.
 * @returns Array of violations found.
 */
export function checkBundleContent(filePath: string, content: string): readonly BundleViolation[] {
  const violations: BundleViolation[] = [];

  for (const marker of FORBIDDEN_BUNDLE_IDENTIFIERS) {
    const index = content.indexOf(marker);
    if (index !== -1) {
      const start = Math.max(0, index - 40);
      const end = Math.min(content.length, index + marker.length + 40);
      const snippet = content.slice(start, end).replace(/\r?\n/gu, ' ');
      violations.push(
        Object.freeze({
          file: filePath,
          marker,
          snippet
        })
      );
    }
  }

  return Object.freeze(violations);
}

/**
 * Checks a sourcemap JSON string for forbidden compiler source files.
 *
 * @param mapFilePath Path to the sourcemap file.
 * @param mapContent Text content of the sourcemap JSON.
 * @returns Array of violations found.
 */
export function checkSourcemapSources(
  mapFilePath: string,
  mapContent: string
): readonly BundleViolation[] {
  const violations: BundleViolation[] = [];

  let mapJson: { sources?: unknown };
  try {
    mapJson = JSON.parse(mapContent) as { sources?: unknown };
  } catch {
    violations.push(
      Object.freeze({
        file: mapFilePath,
        marker: 'invalid-json',
        snippet: 'Sourcemap is not valid JSON.'
      })
    );
    return Object.freeze(violations);
  }

  if (Array.isArray(mapJson.sources)) {
    for (const sourcePath of mapJson.sources) {
      if (typeof sourcePath === 'string') {
        for (const forbidden of FORBIDDEN_SOURCEMAP_SOURCES) {
          if (sourcePath.includes(forbidden)) {
            violations.push(
              Object.freeze({
                file: mapFilePath,
                marker: forbidden,
                snippet: `Sourcemap includes forbidden compiler source file: "${sourcePath}"`
              })
            );
          }
        }
      }
    }
  }

  return Object.freeze(violations);
}

/**
 * Inspects all built bundle files and sourcemaps in `dist/` directory.
 */
export async function main(): Promise<void> {
  const distDir = resolve(process.cwd(), 'dist');
  if (!existsSync(distDir)) {
    console.error('Error: "dist/" directory not found. Please run "npm run build" first.');
    process.exit(1);
  }

  const allFiles = readdirSync(distDir);
  const jsFiles = allFiles
    .filter((file) => file.endsWith('.js') || file.endsWith('.mjs'))
    .map((file) => join(distDir, file));
  const mapFiles = allFiles
    .filter((file) => file.endsWith('.js.map') || file.endsWith('.mjs.map'))
    .map((file) => join(distDir, file));

  if (jsFiles.length === 0) {
    console.error('Error: No JS bundle files found in "dist/".');
    process.exit(1);
  }

  const allViolations: BundleViolation[] = [];

  for (const file of jsFiles) {
    const content = readFileSync(file, 'utf8');
    const violations = checkBundleContent(file, content);
    allViolations.push(...violations);
  }

  for (const mapFile of mapFiles) {
    const content = readFileSync(mapFile, 'utf8');
    const violations = checkSourcemapSources(mapFile, content);
    allViolations.push(...violations);
  }

  if (allViolations.length > 0) {
    console.error(
      `\n❌ Runtime shader bundle check failed with ${allViolations.length} violation(s):\n`
    );
    for (const v of allViolations) {
      console.error(`  File: ${v.file}`);
      console.error(`  Forbidden Marker: "${v.marker}"`);
      console.error(`  Context: "...${v.snippet}..."\n`);
    }
    process.exit(1);
  }

  console.log(
    `✓ Runtime shader bundle check passed: ${jsFiles.length} bundle file(s) and ${mapFiles.length} sourcemap(s) verified clean in dist/`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(`Bundle check failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
