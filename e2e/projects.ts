export const E2E_PROJECTS = Object.freeze(['browser-host-smoke', 'webgl2-smoke'] as const);

export type E2EProject = (typeof E2E_PROJECTS)[number];
