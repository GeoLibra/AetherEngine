import type { BenchmarkRunProfile } from './types';

export type FrameworkCommand = 'validate' | 'changed' | 'all';

export interface FrameworkCliOptions {
  readonly command: FrameworkCommand;
  readonly profile: BenchmarkRunProfile;
  readonly files?: readonly string[];
  readonly base?: string;
  readonly dryRun: boolean;
}

function parseProfile(value: string): BenchmarkRunProfile {
  if (value !== 'smoke' && value !== 'standard' && value !== 'nightly') {
    throw new Error(`Unknown benchmark profile "${value}".`);
  }
  return value;
}

export function parseFrameworkCliOptions(args: readonly string[]): FrameworkCliOptions {
  const command = args[0];
  if (command !== 'validate' && command !== 'changed' && command !== 'all') {
    throw new Error('Expected benchmark framework command: validate, changed, or all.');
  }
  let profile: BenchmarkRunProfile = 'smoke';
  let base: string | undefined;
  let dryRun = false;
  const files: string[] = [];

  for (let index = 1; index < args.length; index++) {
    const option = args[index];
    if (option === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (option !== '--profile' && option !== '--file' && option !== '--base') {
      throw new Error(`Unknown benchmark framework option "${option}".`);
    }
    const value = args[index + 1];
    if (!value) throw new Error(`Benchmark framework option "${option}" requires a value.`);
    index++;
    if (option === '--profile') profile = parseProfile(value);
    if (option === '--file') files.push(value);
    if (option === '--base') base = value;
  }

  return Object.freeze({
    command,
    profile,
    ...(files.length > 0 ? { files: Object.freeze(files) } : {}),
    ...(base ? { base } : {}),
    dryRun
  });
}
