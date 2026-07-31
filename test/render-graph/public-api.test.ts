import { describe, expect, test } from 'vitest';
import {
  RenderGraphBuilder,
  RenderGraphExecutor,
  RenderSystemRegistry,
  compileRenderGraph,
  compileRenderSystems,
  renderSystemToken
} from '../../src';
import { RenderSystemRegistry as RenderingRenderSystemRegistry } from '../../src/rendering';

describe('RenderGraph public API', () => {
  test('exports direct graph and RenderSystem facade entry points from the package', () => {
    expect(RenderGraphBuilder).toBeTypeOf('function');
    expect(RenderGraphExecutor).toBeTypeOf('function');
    expect(RenderSystemRegistry).toBeTypeOf('function');
    expect(compileRenderGraph).toBeTypeOf('function');
    expect(compileRenderSystems).toBeTypeOf('function');
    expect(renderSystemToken('example').id).toBe('example');
    expect(RenderingRenderSystemRegistry).toBe(RenderSystemRegistry);
  });
});
