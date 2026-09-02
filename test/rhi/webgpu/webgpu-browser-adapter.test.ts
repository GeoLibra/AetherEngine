import { describe, expect, test } from 'vitest';
import { requestBrowserWebGPUAdapter } from '../../../src';

describe('browser WebGPU adapter port', () => {
  test('requests one adapter and snapshots browser facts', async () => {
    const adapter = {
      info: { vendor: 'Aether Labs', architecture: 'unit-gpu', description: 'Browser GPU' },
      features: new Set(['timestamp-query']),
      limits: { maxBufferSize: 8192, maxBindGroups: 4 },
      async requestDevice(): Promise<never> {
        throw new Error('not requested');
      }
    };
    const requests: unknown[] = [];
    const environment = {
      gpu: {
        async requestAdapter(options?: unknown): Promise<unknown> {
          requests.push(options);
          return adapter;
        }
      },
      getCanvasContext(): null {
        return null;
      }
    };

    const port = await requestBrowserWebGPUAdapter(environment, {
      powerPreference: 'high-performance',
      forceFallbackAdapter: false
    });
    if (port === null) throw new Error('Expected adapter port.');

    expect(requests).toEqual([
      { powerPreference: 'high-performance', forceFallbackAdapter: false }
    ]);
    expect(port.info).toEqual({
      name: 'Browser GPU',
      vendor: 'Aether Labs',
      architecture: 'unit-gpu'
    });
    expect([...port.features]).toEqual(['timestamp-query']);
    expect(port.limits).toEqual({ maxBufferSize: 8192, maxBindGroups: 4 });
    expect(port.formats.get('bgra8unorm')).toMatchObject({ render: true, copyDst: true });
    adapter.features.add('late-feature');
    expect(port.features.has('late-feature')).toBe(false);
  });

  test('returns null without attaching a canvas when no adapter is available', async () => {
    let canvasContextRequests = 0;
    const port = await requestBrowserWebGPUAdapter(
      {
        gpu: {
          async requestAdapter(): Promise<null> {
            return null;
          }
        },
        getCanvasContext(): null {
          canvasContextRequests += 1;
          return null;
        }
      },
      {}
    );

    expect(port).toBeNull();
    expect(canvasContextRequests).toBe(0);
  });
});
