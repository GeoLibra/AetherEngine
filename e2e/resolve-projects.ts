import { E2E_ROUTING_RULES, type RoutingReason } from './manifest';
import { E2E_PROJECTS, type E2EProject } from './projects';

export interface E2EResolution {
  readonly projects: readonly E2EProject[];
  readonly reasons: readonly RoutingReason[];
  readonly fallback: boolean;
}

export function resolveE2EProjects(paths: readonly string[] | undefined): E2EResolution {
  if (paths === undefined || paths.length === 0) {
    return fallbackResolution([{ path: '', ruleId: 'missing-input-fallback' }]);
  }

  const projects = new Set<E2EProject>();
  const reasons: RoutingReason[] = [];
  let fallback = false;

  for (const path of paths) {
    const normalized = normalizePath(path);
    if (normalized === undefined) {
      fallback = true;
      reasons.push({ path, ruleId: 'invalid-input-fallback' });
      continue;
    }

    const rule = E2E_ROUTING_RULES.find(
      (candidate) =>
        (candidate.exact as readonly string[]).includes(normalized) ||
        candidate.prefixes.some((prefix) => normalized.startsWith(prefix))
    );

    if (rule === undefined) {
      fallback = true;
      reasons.push({ path: normalized, ruleId: 'unmatched-fallback' });
      continue;
    }

    reasons.push({ path: normalized, ruleId: rule.id });
    for (const project of rule.projects) projects.add(project);
  }

  if (fallback) return fallbackResolution(reasons);

  return {
    projects: E2E_PROJECTS.filter((project) => projects.has(project)),
    reasons,
    fallback: false
  };
}

function fallbackResolution(reasons: readonly RoutingReason[]): E2EResolution {
  return { projects: E2E_PROJECTS, reasons, fallback: true };
}

function normalizePath(path: string): string | undefined {
  const normalized = path.replaceAll('\\', '/').replace(/^(?:\.\/)+/, '');
  if (
    normalized.length === 0 ||
    normalized.startsWith('/') ||
    /^[a-zA-Z]:\//.test(normalized) ||
    normalized.includes('\u0000') ||
    normalized
      .split('/')
      .some((segment) => segment.length === 0 || segment === '.' || segment === '..')
  ) {
    return undefined;
  }
  return normalized;
}
