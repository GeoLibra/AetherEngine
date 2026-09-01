/**
 * @file Quality gate to verify production runtime browser bundles contain no compiler or tooling payloads.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Markers that MUST NEVER appear in production engine runtime bundles.
 */
export const FORBIDDEN_BUNDLE_MARKERS = Object.freeze([
  'node:child_process',
  'child_process',
  '@naga/wasm',
  'naga.wasm',
  'naga_oil',
  'Cargo.toml',
  'tools/naga-shader-validator',
  'src/shader/frontend/parser',
  'src/shader/frontend/lexer',
  'src/shader/frontend/typecheck'
]);

export interface BundleViolation {
  readonly file: string;
  readonly marker: string;
  readonly snippet: string;
}

/**
 * Checks a bundle string for forbidden tooling / compiler markers.
 *
 * @param filePath Path to the bundle file for diagnostic reporting.
 * @param content Text content of the bundle file.
 * @returns Array of violations found.
 */
export function checkBundleContent(filePath: string, content: string): readonly BundleViolation[] {
  const violations: BundleViolation[] = [];

  for (const marker of FORBIDDEN_BUNDLE_MARKERS) {
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
 * Inspects all built bundle files in `dist/` directory.
 */
export async function main(): Promise<void> {
  const distDir = resolve(process.cwd(), 'dist');
  if (!existsSync(distDir)) {
    console.error('Error: "dist/" directory not found. Please run "npm run build" first.');
    process.exit(1);
  }

  const jsFiles = readdirSync(distDir)
    .filter((file) => file.endsWith('.js') || file.endsWith('.mjs'))
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
    `✓ Runtime shader bundle check passed: ${jsFiles.length} file(s) verified clean in dist/`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error(`Bundle check failed: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
