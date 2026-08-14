import { describe, expect, test } from 'vitest';

import { resolveE2EProjects } from './resolve-projects';

describe('resolveE2EProjects', () => {
  test('routes browser host source changes to the browser host smoke project', () => {
    expect(resolveE2EProjects(['src/platform/browser-host.ts']).projects).toEqual([
      'browser-host-smoke'
    ]);
  });

  test('routes WebGL2 source changes to the WebGL2 smoke project', () => {
    expect(resolveE2EProjects(['src/rhi/webgl2/device.ts']).projects).toEqual(['webgl2-render']);
  });

  test('routes browser WebGPU implementation changes to the WebGPU render project', () => {
    expect(resolveE2EProjects(['src/rhi/webgpu/browser/device-port.ts']).projects).toEqual([
      'webgpu-render'
    ]);
  });

  test('routes E2E infrastructure changes to every smoke project in stable order', () => {
    expect(resolveE2EProjects(['playwright.config.ts']).projects).toEqual([
      'browser-host-smoke',
      'webgl2-render',
      'webgpu-render'
    ]);
  });

  test('does not route explicit non-E2E files', () => {
    expect(resolveE2EProjects(['README.md']).projects).toEqual([]);
  });

  test('fails open for unmatched valid paths', () => {
    expect(resolveE2EProjects(['src/material/asset.ts']).fallback).toBe(true);
  });

  test('fails open for an empty path list', () => {
    expect(resolveE2EProjects([]).fallback).toBe(true);
  });

  test('fails open for an omitted path list', () => {
    expect(resolveE2EProjects(undefined).fallback).toBe(true);
  });

  test('deduplicates matched projects while retaining stable project order', () => {
    expect(
      resolveE2EProjects([
        'src/rhi/webgl2/device.ts',
        'src/platform/browser-host.ts',
        'e2e/spec.ts'
      ]).projects
    ).toEqual(['browser-host-smoke', 'webgl2-render', 'webgpu-render']);
  });

  test('reports normalized paths and routing rules', () => {
    expect(resolveE2EProjects(['.\\src\\platform\\browser-host.ts']).reasons).toEqual([
      { path: 'src/platform/browser-host.ts', ruleId: 'browser-host' }
    ]);
  });

  test('reports unmatched fallback reasons', () => {
    expect(resolveE2EProjects(['src/material/asset.ts']).reasons).toEqual([
      { path: 'src/material/asset.ts', ruleId: 'unmatched-fallback' }
    ]);
  });

  test('fails open for blank, absolute, and invalid path entries', () => {
    for (const path of [
      '',
      '/workspace/src/platform/browser-host.ts',
      'src/../platform/browser-host.ts'
    ]) {
      expect(resolveE2EProjects([path])).toMatchObject({
        projects: ['browser-host-smoke', 'webgl2-render', 'webgpu-render'],
        fallback: true,
        reasons: [{ path, ruleId: 'invalid-input-fallback' }]
      });
    }
  });

  test('reports a reason for every entry when mixed input requires fallback', () => {
    expect(
      resolveE2EProjects([
        'src/platform/browser-host.ts',
        'src/../platform/browser-host.ts',
        'src/material/asset.ts',
        'README.md'
      ])
    ).toMatchObject({
      projects: ['browser-host-smoke', 'webgl2-render', 'webgpu-render'],
      fallback: true,
      reasons: [
        { path: 'src/platform/browser-host.ts', ruleId: 'browser-host' },
        {
          path: 'src/../platform/browser-host.ts',
          ruleId: 'invalid-input-fallback'
        },
        { path: 'src/material/asset.ts', ruleId: 'unmatched-fallback' },
        { path: 'README.md', ruleId: 'explicit-no-e2e' }
      ]
    });
  });
});
