import { stdin } from 'node:process';
import { pathToFileURL } from 'node:url';

import type { RoutingReason } from './manifest';
import type { E2EProject } from './projects';
import { resolveE2EProjects } from './resolve-projects';

export function parseChangedPaths(input: string): readonly string[] | undefined {
  if (input.trim().length === 0) return undefined;

  return input.split(/\r?\n/).filter((path) => path.length > 0);
}

export function createMatrixOutput(input: string): {
  readonly include: readonly { readonly project: E2EProject }[];
  readonly reasons: readonly RoutingReason[];
  readonly fallback: boolean;
} {
  const resolution = resolveE2EProjects(parseChangedPaths(input));

  return {
    include: resolution.projects.map((project) => ({ project })),
    reasons: resolution.reasons,
    fallback: resolution.fallback
  };
}

async function readInput(input: AsyncIterable<string>): Promise<string> {
  let contents = '';
  for await (const chunk of input) contents += chunk;
  return contents;
}

export async function runCli(
  input: AsyncIterable<string>,
  writeOutput: (output: string) => void
): Promise<void> {
  let changedPaths = '';

  try {
    changedPaths = await readInput(input);
  } catch {
    // A failed change feed must select every E2E project instead of silently skipping coverage.
  }

  writeOutput(`${JSON.stringify(createMatrixOutput(changedPaths))}\n`);
}

async function main(): Promise<void> {
  stdin.setEncoding('utf8');
  await runCli(stdin, (output) => process.stdout.write(output));
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
