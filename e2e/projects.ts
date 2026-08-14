export const E2E_PROJECTS = Object.freeze([
  'browser-host-smoke',
  'webgl2-render',
  'webgpu-render'
] as const);

export type E2EProject = (typeof E2E_PROJECTS)[number];
