import { describe, expect, test, vi } from 'vitest';
import {
  PipelineCache,
  PreparedRenderPipelineRegistry,
  RHIPipelineCompiler,
  createPipelineCompileRequest
} from '../../src/rendering';
import { NullDevice } from '../../src/rhi';
import type { GPUPrimitiveState } from '../../src/rhi/contracts';

describe('PreparedRenderPipelineRegistry', () => {
  test('snapshots caller-owned descriptor values against an exact compile identity', () => {
    const device = new NullDevice();
    const module = device.createShaderModule({ code: 'shader' });
    const primitive: GPUPrimitiveState = { topology: 'triangle-list' };
    const descriptor = { vertex: { module }, primitive };
    const registry = new PreparedRenderPipelineRegistry();
    const request = fixtureRequest(device.generation);

    registry.register(request, descriptor);
    primitive.topology = 'line-list';

    expect(registry.resolve(request)?.descriptor.primitive?.topology).toBe('triangle-list');
    expect(() =>
      registry.resolve({ ...request, shaderRevision: request.shaderRevision + 1 })
    ).toThrow(/identity/i);
  });

  test('rejects a conflicting prepared artifact for the same canonical pipeline key', () => {
    const device = new NullDevice();
    const registry = new PreparedRenderPipelineRegistry();
    const request = fixtureRequest(device.generation);

    registry.register(request, {});

    expect(() => registry.register({ ...request, layoutRevision: 8 }, {})).toThrow(/identity/i);
  });
});

describe('RHIPipelineCompiler', () => {
  test('creates through the later PipelineCache compile microtask, never request or snapshot', async () => {
    const device = new NullDevice();
    const createPipeline = vi.spyOn(device, 'createRenderPipeline');
    const registry = new PreparedRenderPipelineRegistry();
    const request = fixtureRequest(device.generation);
    registry.register(request, {});
    const cache = new PipelineCache(new RHIPipelineCompiler(device, registry));

    cache.request(request);

    expect(createPipeline).not.toHaveBeenCalled();
    expect(cache.snapshot(request.pipelineKey).kind).toBe('queued');
    await flushCompilation();
    expect(createPipeline).toHaveBeenCalledTimes(1);
    expect(cache.snapshot(request.pipelineKey).kind).toBe('ready');
  });

  test('returns bounded typed diagnostics for missing artifacts and backend failures', async () => {
    const device = new NullDevice();
    const registry = new PreparedRenderPipelineRegistry();
    const compiler = new RHIPipelineCompiler(device, registry);
    const request = fixtureRequest(device.generation);

    await expect(compiler.compile(request)).resolves.toMatchObject({
      status: 'error',
      diagnostic: { code: 'pipeline-artifact-missing' }
    });

    registry.register(request, {});
    vi.spyOn(device, 'createRenderPipeline').mockImplementation(() => {
      throw new Error(`backend failed ${'x'.repeat(1500)}`);
    });
    const failure = await compiler.compile(request);
    expect(failure).toMatchObject({
      status: 'error',
      diagnostic: { code: 'rhi-pipeline-creation-failed' }
    });
    if (failure.status === 'error')
      expect(failure.diagnostic.message.length).toBeLessThanOrEqual(1024);
  });

  test('rejects compilation against a different device generation', async () => {
    const device = new NullDevice();
    const request = fixtureRequest(device.generation + 1);
    const registry = new PreparedRenderPipelineRegistry();
    registry.register(request, {});

    await expect(new RHIPipelineCompiler(device, registry).compile(request)).resolves.toMatchObject(
      {
        status: 'error',
        diagnostic: { code: 'pipeline-device-generation-mismatch' }
      }
    );
  });
});

function fixtureRequest(deviceGeneration: number) {
  return createPipelineCompileRequest({
    pipelineKey: 'pipeline:prepared',
    requestRevision: 1,
    shaderRevision: 2,
    layoutRevision: 3,
    featurePolicyHash: 'policy:a',
    deviceGeneration
  });
}

async function flushCompilation(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
