import { readFile } from 'node:fs/promises';

import { describe, expect, test } from 'vitest';

const WORKFLOW_PATH = new URL('../.github/workflows/e2e.yml', import.meta.url);

describe('E2E GitHub Actions workflow', () => {
  test('runs affected Playwright projects in parallel for pull requests', async () => {
    const workflow = await readFile(WORKFLOW_PATH, 'utf8');

    expect(workflow).toMatch(/^on:\s*\n\s+pull_request:/m);
    expect(workflow).toContain('group: ${{ github.workflow }}-${{ github.ref }}');
    expect(workflow).toContain('cancel-in-progress: true');

    expect(workflow).toContain('pnpm vitest run e2e/resolve-projects.test.ts e2e/cli.test.ts');
    expect(workflow).toContain('pnpm --silent e2e:resolve');
    expect(workflow).toContain('git diff --name-only --diff-filter=ACMR');
    expect(workflow).toContain('>> "$GITHUB_OUTPUT"');

    expect(workflow).toContain("if: needs.resolve.outputs.has-projects == 'true'");
    expect(workflow).toContain('fail-fast: false');
    expect(workflow).toContain('matrix: ${{ fromJSON(needs.resolve.outputs.matrix) }}');
    expect(workflow).toContain('pnpm exec playwright install --with-deps chromium');
    expect(workflow).toContain('pnpm e2e --project=${{ matrix.project }}');
    expect(workflow).not.toContain('pnpm e2e -- --project');

    expect(workflow).toContain('uses: actions/checkout@v7');
    expect(workflow).toContain('uses: pnpm/action-setup@v6');
    expect(workflow).toContain('uses: actions/setup-node@v6');
    expect(workflow).toContain('uses: actions/upload-artifact@v7');
    expect(workflow).toContain('if: failure()');
    expect(workflow).toContain(
      'name: e2e-${{ matrix.project }}-${{ github.run_id }}-${{ github.run_attempt }}'
    );
  });
});
