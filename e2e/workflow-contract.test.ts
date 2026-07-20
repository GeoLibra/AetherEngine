import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, test } from 'vitest';

const WORKFLOW_PATH = new URL('../.github/workflows/e2e.yml', import.meta.url);
const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('E2E GitHub Actions workflow', () => {
  test('runs for pull requests with ref-scoped cancellation and pinned action majors', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');
    const resolveJob = extractYamlBlock(workflow, '  resolve:');
    const e2eJob = extractYamlBlock(workflow, '  e2e:');

    expect(workflow).toMatch(/^on:\s*\n\s+pull_request:/m);
    expect(workflow).toContain('group: ${{ github.workflow }}-${{ github.ref }}');
    expect(workflow).toContain('cancel-in-progress: true');

    for (const job of [resolveJob, e2eJob]) {
      expect(job).toContain('uses: actions/checkout@v7');
      expect(job).toContain('uses: pnpm/action-setup@v6');
      expect(job).toContain('uses: actions/setup-node@v6');
    }
    expect(resolveJob).not.toContain('actions/upload-artifact');
    expect(e2eJob).toContain('uses: actions/upload-artifact@v7');
  });

  test('publishes an include-only matrix and keeps resolver diagnostics separate', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');
    const resolveJob = extractYamlBlock(workflow, '  resolve:');
    const resolveStep = extractYamlBlock(resolveJob, '      - name: Resolve affected projects');
    const script = extractRunScript(resolveStep)
      .replaceAll('${{ github.event.pull_request.base.sha }}', 'base-sha')
      .replaceAll('${{ github.event.pull_request.head.sha }}', 'head-sha');
    const outputs = await executeResolverStep(script, {
      include: [{ project: 'browser-host-smoke' }],
      reasons: [{ path: 'src/platform/browser-host.ts', ruleId: 'browser-host' }],
      fallback: false
    });
    const emptyOutputs = await executeResolverStep(script, {
      include: [],
      reasons: [{ path: 'README.md', ruleId: 'documentation' }],
      fallback: false
    });

    expect(resolveJob).toContain('matrix: ${{ steps.resolve.outputs.matrix }}');
    expect(resolveJob).toContain('diagnostics: ${{ steps.resolve.outputs.diagnostics }}');
    expect(outputs.matrix).toEqual({ include: [{ project: 'browser-host-smoke' }] });
    expect(Object.keys(outputs.matrix)).toEqual(['include']);
    expect(outputs.diagnostics).toEqual({
      reasons: [{ path: 'src/platform/browser-host.ts', ruleId: 'browser-host' }],
      fallback: false
    });
    expect(outputs.hasProjects).toBe('true');
    expect(emptyOutputs.matrix).toEqual({ include: [] });
    expect(emptyOutputs.diagnostics).toEqual({
      reasons: [{ path: 'README.md', ruleId: 'documentation' }],
      fallback: false
    });
    expect(emptyOutputs.hasProjects).toBe('false');
  });

  test('guards an empty matrix and passes its project through a quoted environment variable', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');
    const resolveJob = extractYamlBlock(workflow, '  resolve:');
    const e2eJob = extractYamlBlock(workflow, '  e2e:');
    const runStep = extractYamlBlock(e2eJob, '      - name: Run ${{ matrix.project }}');
    const uploadStep = extractYamlBlock(e2eJob, '      - name: Upload failure artifacts');

    expect(resolveJob).toContain('pnpm vitest run e2e/resolve-projects.test.ts e2e/cli.test.ts');
    expect(resolveJob).toContain('pnpm --silent e2e:resolve');
    expect(resolveJob).toContain('git diff --name-only --diff-filter=ACMR');
    expect(resolveJob).not.toContain('pnpm exec playwright install');

    expect(e2eJob).toContain('needs: resolve');
    expect(e2eJob).toContain("if: needs.resolve.outputs.has-projects == 'true'");
    expect(e2eJob).toContain('fail-fast: false');
    expect(e2eJob).toContain('matrix: ${{ fromJSON(needs.resolve.outputs.matrix) }}');
    expect(e2eJob).toContain('pnpm exec playwright install --with-deps chromium');
    expect(runStep).toContain('E2E_PROJECT: ${{ matrix.project }}');
    expect(runStep).toContain('run: pnpm e2e --project="$E2E_PROJECT"');
    expect(runStep).not.toContain('--project=${{ matrix.project }}');

    expect(uploadStep).toContain('if: failure()');
    expect(uploadStep).toContain('uses: actions/upload-artifact@v7');
    expect(uploadStep).toContain(
      'name: e2e-${{ matrix.project }}-${{ github.run_id }}-${{ github.run_attempt }}'
    );
  });
});

function extractYamlBlock(source: string, header: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line === header);
  if (start < 0) throw new Error(`Missing workflow block: ${header.trim()}`);

  const indentation = header.length - header.trimStart().length;
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (line === undefined) break;
    if (line.trim().length > 0 && line.length - line.trimStart().length <= indentation) break;
    end += 1;
  }

  return lines.slice(start, end).join('\n');
}

function extractRunScript(step: string): string {
  const lines = step.split('\n');
  const runLine = lines.findIndex((line) => line.trim() === 'run: |');
  if (runLine < 0) throw new Error('Expected a multiline run script');
  const runHeader = lines[runLine];
  if (runHeader === undefined) throw new Error('Expected a multiline run script');

  const indentation = runHeader.length - runHeader.trimStart().length + 2;
  return lines
    .slice(runLine + 1)
    .map((line) => line.slice(indentation))
    .join('\n');
}

async function executeResolverStep(
  script: string,
  resolution: {
    readonly include: readonly { readonly project: string }[];
    readonly reasons: readonly { readonly path: string; readonly ruleId: string }[];
    readonly fallback: boolean;
  }
): Promise<{
  readonly matrix: Record<string, unknown>;
  readonly diagnostics: unknown;
  readonly hasProjects: string | undefined;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'aether-e2e-workflow-'));
  temporaryDirectories.push(directory);
  const outputPath = join(directory, 'github-output');
  await writeExecutable(
    join(directory, 'git'),
    "#!/usr/bin/env bash\nprintf 'src/platform/browser-host.ts\\n'\n"
  );
  await writeExecutable(
    join(directory, 'pnpm'),
    `#!/usr/bin/env bash\nprintf '%s\\n' '${JSON.stringify(resolution)}'\n`
  );

  await execFileAsync('bash', ['-c', script], {
    env: {
      ...process.env,
      PATH: `${directory}:${process.env.PATH ?? ''}`,
      GITHUB_OUTPUT: outputPath
    }
  });

  const values = Object.fromEntries(
    (await readFile(outputPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      })
  );

  return {
    matrix: JSON.parse(values.matrix ?? 'null'),
    diagnostics: JSON.parse(values.diagnostics ?? 'null'),
    hasProjects: values['has-projects']
  };
}

async function writeExecutable(path: string, contents: string): Promise<void> {
  await writeFile(path, contents);
  await chmod(path, 0o755);
}
