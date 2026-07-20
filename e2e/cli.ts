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

async function readStdin(): Promise<string> {
  stdin.setEncoding('utf8');

  let input = '';
  for await (const chunk of stdin) input += chunk;
  return input;
}

async function main(): Promise<void> {
  process.stdout.write(`${JSON.stringify(createMatrixOutput(await readStdin()))}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  void main();
}
