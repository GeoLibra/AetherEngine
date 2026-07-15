import { runCommand, type CommandResult } from '../core/process';

type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

export function parseChangedPaths(output: string): readonly string[] {
  return Object.freeze([...new Set(
    output.split(/\r?\n/u).map((path) => path.trim()).filter(Boolean)
  )].sort());
}

export async function collectChangedFiles(
  base: string | undefined,
  execute: CommandRunner = runCommand
): Promise<readonly string[]> {
  const outputs: string[] = [];
  if (base) {
    outputs.push((await execute('git', ['diff', '--name-only', `${base}...HEAD`])).stdout);
  }
  outputs.push((await execute('git', ['diff', '--name-only', 'HEAD'])).stdout);
  outputs.push((await execute('git', ['ls-files', '--others', '--exclude-standard'])).stdout);
  return parseChangedPaths(outputs.join('\n'));
}
