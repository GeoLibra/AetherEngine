import { pathToFileURL } from 'node:url';

import { createBrowserDoctorProbe } from './browser-probe';
import { renderDoctorReport } from './report';
import { runDoctor } from './run-doctor';

export type DoctorCliOptions =
  | Readonly<{ kind: 'run'; json: boolean }>
  | Readonly<{ kind: 'help' }>
  | Readonly<{ kind: 'invalid'; argument: string }>;

const HELP = `Usage: pnpm doctor [--json] [--help]

Options:
  --json  Output a structured JSON report
  --help  Show this help
`;

/** Parses Doctor CLI arguments without performing platform work. */
export function parseDoctorCliArgs(args: readonly string[]): DoctorCliOptions {
  if (args.includes('--help') || args.includes('-h')) return Object.freeze({ kind: 'help' });
  const unknown = args.find((arg) => arg !== '--json' && arg !== '--');
  if (unknown !== undefined) return Object.freeze({ kind: 'invalid', argument: unknown });
  return Object.freeze({ kind: 'run', json: args.includes('--json') });
}

/**
 * Runs the real browser probe and writes its report.
 *
 * @returns `0` for a verified backend, `1` for an unsuccessful or unverified probe, and `2` for
 * invalid command-line arguments.
 */
export async function runDoctorCli(args: readonly string[]): Promise<number> {
  const options = parseDoctorCliArgs(args);
  if (options.kind === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (options.kind === 'invalid') {
    process.stderr.write(`Unknown Aether Doctor option: ${options.argument}\n`);
    return 2;
  }

  let browserProbe: Awaited<ReturnType<typeof createBrowserDoctorProbe>> | undefined;
  let exitCode = 1;
  try {
    browserProbe = await createBrowserDoctorProbe();
    const report = await runDoctor(browserProbe.probe);
    process.stdout.write(
      options.json ? `${JSON.stringify(report, null, 2)}\n` : renderDoctorReport(report)
    );
    exitCode = report.verdict === 'verified' || report.verdict === 'verified-with-fallback' ? 0 : 1;
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`Aether Doctor could not start: ${message}\n`);
  }
  try {
    await browserProbe?.close();
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    process.stderr.write(`Aether Doctor could not close its harness server: ${message}\n`);
    return 1;
  }
  return exitCode;
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href) {
  process.exitCode = await runDoctorCli(process.argv.slice(2));
}
