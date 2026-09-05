import { describe, expect, test } from 'vitest';

import {
  browserHarnessHasFinished,
  listenDoctorServer,
  resolveDoctorServerUrl
} from '../../tools/doctor/browser-probe';
import type { E2EState } from '../../e2e/harness/types';
import { parseDoctorCliArgs } from '../../tools/doctor/cli';

import {
  classifyDoctorVerdict,
  createBrowserBackendResult,
  inspectPixelReadback,
  renderDoctorReport,
  runDoctor,
  type DoctorBackendResult
} from '../../tools/doctor';

function backend(
  backendName: 'webgpu' | 'webgl2',
  status: DoctorBackendResult['status'],
  overrides: Partial<DoctorBackendResult> = {}
): DoctorBackendResult {
  return Object.freeze({
    backend: backendName,
    status,
    stages: Object.freeze([]),
    ...overrides
  });
}

describe('Aether Doctor', () => {
  test('verifies a non-uniform opaque pixel readback with a stable checksum', () => {
    const pixels = new Uint8Array([10, 31, 61, 255, 240, 80, 40, 255]);

    expect(inspectPixelReadback(pixels)).toEqual({
      byteLength: 8,
      checksum: 'fnv1a32:63c1587b',
      opaquePixels: 2,
      distinctColors: 2,
      verified: true
    });
  });

  test('rejects an empty or uniform readback as unverified', () => {
    expect(inspectPixelReadback(new Uint8Array()).verified).toBe(false);
    expect(inspectPixelReadback(new Uint8Array([10, 31, 61, 255, 10, 31, 61, 255])).verified).toBe(
      false
    );
  });

  test('rejects an incomplete RGBA8 texel', () => {
    expect(() => inspectPixelReadback(new Uint8Array([1, 2, 3]))).toThrow('complete RGBA8 texels');
  });

  test('reports verified when WebGPU completes the real render probe', () => {
    expect(classifyDoctorVerdict([backend('webgpu', 'verified')])).toBe('verified');
  });

  test('reports verified-with-fallback only when WebGPU fails and WebGL2 verifies', () => {
    expect(
      classifyDoctorVerdict([backend('webgpu', 'failed'), backend('webgl2', 'verified')])
    ).toBe('verified-with-fallback');
  });

  test('preserves unsupported and unverified terminal outcomes', () => {
    expect(classifyDoctorVerdict([backend('webgpu', 'unsupported')])).toBe('unsupported');
    expect(classifyDoctorVerdict([backend('webgpu', 'unverified')])).toBe('unverified');
    expect(classifyDoctorVerdict([backend('webgpu', 'failed')])).toBe('failed');
  });

  test('renders actionable backend stages and the terminal verdict', () => {
    const output = renderDoctorReport({
      verdict: 'verified-with-fallback',
      durationMs: 12,
      backends: [
        backend('webgpu', 'failed', {
          stages: [
            Object.freeze({
              name: 'adapter',
              status: 'failed',
              message: 'requestAdapter returned null'
            })
          ]
        }),
        backend('webgl2', 'verified', {
          stages: [Object.freeze({ name: 'pixel-readback', status: 'passed' })]
        })
      ]
    });

    expect(output).toContain('WebGPU');
    expect(output).toContain('requestAdapter returned null');
    expect(output).toContain('WebGL2');
    expect(output).toContain('VERIFIED WITH FALLBACK');
  });

  test('does not probe the fallback after WebGPU verifies', async () => {
    const calls: string[] = [];
    const report = await runDoctor(async (name) => {
      calls.push(name);
      return backend(name, 'verified');
    });

    expect(calls).toEqual(['webgpu']);
    expect(report.verdict).toBe('verified');
  });

  test('probes WebGL2 after a WebGPU failure and records fallback verification', async () => {
    const report = await runDoctor(async (name) =>
      backend(name, name === 'webgpu' ? 'failed' : 'verified')
    );

    expect(report.backends.map(({ backend: name }) => name)).toEqual(['webgpu', 'webgl2']);
    expect(report.verdict).toBe('verified-with-fallback');
  });

  test('converts an unexpected probe exception into an actionable failure', async () => {
    const report = await runDoctor(async (name) => {
      if (name === 'webgpu') throw new Error('browser crashed');
      return backend(name, 'unsupported');
    });

    expect(report.backends[0]).toMatchObject({
      backend: 'webgpu',
      status: 'failed',
      stages: [{ name: 'probe', status: 'failed', message: 'browser crashed' }]
    });
    expect(report.verdict).toBe('failed');
  });

  test('turns a rendered browser harness and pixel readback into passed stages', () => {
    const result = createBrowserBackendResult(
      'webgpu',
      {
        status: 'ready',
        host: 'browser',
        backend: 'webgpu',
        detail: {
          adapterName: 'Test GPU',
          renderPasses: 1,
          indexedDrawCalls: 2,
          nativeQueueSubmits: 1,
          validationErrors: 0
        }
      },
      new Uint8Array([10, 31, 61, 255, 240, 80, 40, 255])
    );

    expect(result.status).toBe('verified');
    expect(result.stages.map(({ name, status }) => [name, status])).toEqual([
      ['adapter-device-surface', 'passed'],
      ['render-submit', 'passed'],
      ['pixel-readback', 'passed']
    ]);
  });

  test('does not verify a harness whose rendered pixels fail the oracle', () => {
    const result = createBrowserBackendResult(
      'webgl2',
      { status: 'ready', host: 'browser', backend: 'webgl2', detail: {} },
      new Uint8Array([10, 31, 61, 255, 10, 31, 61, 255])
    );

    expect(result.status).toBe('unverified');
    expect(result.stages).toContainEqual(
      expect.objectContaining({ name: 'pixel-readback', status: 'failed' })
    );
  });

  test('does not verify a rendered frame that reported validation errors', () => {
    const result = createBrowserBackendResult(
      'webgpu',
      {
        status: 'ready',
        host: 'browser',
        backend: 'webgpu',
        detail: { renderPasses: 1, nativeQueueSubmits: 1, validationErrors: 1 }
      },
      new Uint8Array([10, 31, 61, 255, 240, 80, 40, 255])
    );

    expect(result.status).toBe('unverified');
    expect(result.stages).toContainEqual(
      expect.objectContaining({ name: 'render-submit', status: 'failed' })
    );
  });

  test('does not verify WebGL2 when any reported GL error is nonzero', () => {
    const result = createBrowserBackendResult(
      'webgl2',
      {
        status: 'ready',
        host: 'browser',
        backend: 'webgl2',
        detail: { renderPasses: 1, nativeQueueSubmits: 1, glErrors: [0, 1282, 0] }
      },
      new Uint8Array([10, 31, 61, 255, 240, 80, 40, 255])
    );

    expect(result.status).toBe('unverified');
    expect(result.stages).toContainEqual(
      expect.objectContaining({ name: 'render-submit', status: 'failed' })
    );
  });

  test('does not verify WebGL2 when GL error evidence is missing', () => {
    const result = createBrowserBackendResult(
      'webgl2',
      {
        status: 'ready',
        host: 'browser',
        backend: 'webgl2',
        detail: { renderPasses: 1, nativeQueueSubmits: 1 }
      },
      new Uint8Array([10, 31, 61, 255, 240, 80, 40, 255])
    );

    expect(result.status).toBe('unverified');
  });

  test('classifies structured backend unavailability as unsupported', () => {
    const state = {
      status: 'failed',
      message: 'No requested browser graphics backend could be created.',
      graphicsAttempts: [
        {
          backend: 'webgpu',
          stage: 'adapter',
          classification: 'unavailable',
          message: 'requestAdapter returned null'
        }
      ]
    } as E2EState;

    expect(createBrowserBackendResult('webgpu', state, new Uint8Array()).status).toBe(
      'unsupported'
    );
  });

  test('waits until the harness bridge exists and leaves booting state', () => {
    expect(browserHarnessHasFinished(undefined)).toBe(false);
    expect(browserHarnessHasFinished({ state: () => ({ status: 'booting' }) })).toBe(false);
    expect(
      browserHarnessHasFinished({
        state: () => ({ status: 'failed', message: 'adapter unavailable' })
      })
    ).toBe(true);
  });

  test('uses the dynamically assigned local harness URL', () => {
    expect(
      resolveDoctorServerUrl({
        resolvedUrls: { local: ['http://127.0.0.1:54321/'], network: [] }
      })
    ).toBe('http://127.0.0.1:54321');
  });

  test('parses JSON and help CLI modes without starting a graphics probe', () => {
    expect(parseDoctorCliArgs(['--', '--json'])).toEqual({ kind: 'run', json: true });
    expect(parseDoctorCliArgs(['--help'])).toEqual({ kind: 'help' });
    expect(parseDoctorCliArgs(['-h'])).toEqual({ kind: 'help' });
  });

  test('rejects unknown CLI options with the offending argument', () => {
    expect(parseDoctorCliArgs(['--wat'])).toEqual({ kind: 'invalid', argument: '--wat' });
  });

  test('closes a partially initialized harness server when listen fails', async () => {
    let closes = 0;
    await expect(
      listenDoctorServer({
        listen: async () => {
          throw new Error('port unavailable');
        },
        close: async () => {
          closes += 1;
        }
      })
    ).rejects.toThrow('port unavailable');
    expect(closes).toBe(1);
  });
});
