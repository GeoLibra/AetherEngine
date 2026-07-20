import { describe, expect, test } from 'vitest';

import { createMatrixOutput, parseChangedPaths, runCli } from './cli';

describe('parseChangedPaths', () => {
  test('parses newline-delimited changed paths', () => {
    expect(parseChangedPaths('src/platform/browser-host.ts\nsrc/rhi/webgl2/device.ts\n')).toEqual([
      'src/platform/browser-host.ts',
      'src/rhi/webgl2/device.ts'
    ]);
  });

  test('parses CRLF-delimited changed paths', () => {
    expect(
      parseChangedPaths('src/platform/browser-host.ts\r\nsrc/rhi/webgl2/device.ts\r\n')
    ).toEqual(['src/platform/browser-host.ts', 'src/rhi/webgl2/device.ts']);
  });

  test('treats blank input as missing changed paths', () => {
    expect(parseChangedPaths(' \n\r\n ')).toBeUndefined();
  });
});

describe('createMatrixOutput', () => {
  test('creates a parseable GitHub Actions matrix for platform changes', () => {
    const output = createMatrixOutput('src/platform/browser-host.ts\n');

    expect(output).toMatchObject({
      include: [{ project: 'browser-host-smoke' }],
      fallback: false
    });
    expect(JSON.parse(JSON.stringify(output))).toEqual(output);
  });

  test('fails open to every project for blank input', () => {
    expect(createMatrixOutput('')).toMatchObject({
      include: [{ project: 'browser-host-smoke' }, { project: 'webgl2-smoke' }],
      fallback: true
    });
  });
});

describe('runCli', () => {
  test('fails open with one JSON line when changed-path input cannot be read', async () => {
    async function* unreadableInput(): AsyncGenerator<string> {
      throw new Error('stdin read failed');
    }

    let stdout = '';
    await runCli(unreadableInput(), (line) => {
      stdout += line;
    });

    expect(stdout).toBe(`${JSON.stringify(createMatrixOutput(''))}\n`);
    expect(JSON.parse(stdout)).toMatchObject({
      include: [{ project: 'browser-host-smoke' }, { project: 'webgl2-smoke' }],
      fallback: true
    });
  });
});
