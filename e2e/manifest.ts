import { E2E_PROJECTS, type E2EProject } from './projects';

export interface E2ERoutingRule {
  readonly id: string;
  readonly prefixes: readonly string[];
  readonly exact: readonly string[];
  readonly projects: readonly E2EProject[];
}

export interface RoutingReason {
  readonly path: string;
  readonly ruleId: string;
}

export const E2E_ROUTING_RULES = Object.freeze([
  {
    id: 'react-vite-render-example',
    prefixes: Object.freeze(['examples/react-vite-ts/', 'src/rendering/baseline/']),
    exact: Object.freeze([]),
    projects: Object.freeze(['react-vite-webgl2', 'react-vite-webgpu'] as const)
  },
  {
    id: 'e2e-infrastructure',
    prefixes: Object.freeze(['e2e/', '.github/workflows/e2e.yml']),
    exact: Object.freeze(['playwright.config.ts']),
    projects: E2E_PROJECTS
  },
  {
    id: 'browser-webgpu',
    prefixes: Object.freeze([
      'src/rhi/webgpu/browser/',
      'test/rhi/webgpu/webgpu-browser',
      'src/platform/browser/',
      'src/platform/browser-graphics',
      'test/platform/platform-browser-graphics'
    ]),
    exact: Object.freeze(['engine/design/v2/03-platform/03-webgpu-backend.md']),
    projects: Object.freeze(['webgpu-render'] as const)
  },
  {
    id: 'browser-host',
    prefixes: Object.freeze(['src/platform/', 'test/platform/']),
    exact: Object.freeze(['engine/design/v2/03-platform/01-host-window-surface.md']),
    projects: Object.freeze(['browser-host-smoke'] as const)
  },
  {
    id: 'webgl2',
    prefixes: Object.freeze(['src/rhi/webgl2/', 'test/rhi/webgl2/']),
    exact: Object.freeze(['engine/design/v2/03-platform/04-webgl2-backend.md']),
    projects: Object.freeze(['webgl2-render'] as const)
  },
  {
    id: 'rhi-contract',
    prefixes: Object.freeze(['src/rhi/contracts/', 'test/rhi/contracts/']),
    exact: Object.freeze(['engine/design/v2/03-platform/02-rhi-contract.md']),
    projects: Object.freeze(['webgl2-render'] as const)
  },
  {
    id: 'explicit-no-e2e',
    prefixes: Object.freeze(['docs/', 'test/benchmark/', 'benchmark/']),
    exact: Object.freeze(['README.md']),
    projects: Object.freeze([] as const)
  }
] satisfies readonly E2ERoutingRule[]);
