import type { ResourceBudget } from './types';

export const RESOURCE_BUDGET_FIELDS = Object.freeze([
  'cpuTimeMs',
  'gpuTimeMs',
  'cpuMemoryBytes',
  'gpuMemoryBytes',
  'uploadBytesPerFrame',
  'readbackBytesPerFrame',
  'compileTimeMs'
] as const);

export const ZERO_RESOURCE_BUDGET: ResourceBudget = Object.freeze({
  cpuTimeMs: 0,
  gpuTimeMs: 0,
  cpuMemoryBytes: 0,
  gpuMemoryBytes: 0,
  uploadBytesPerFrame: 0,
  readbackBytesPerFrame: 0,
  compileTimeMs: 0
});

export function validateResourceBudget(budget: ResourceBudget, label = 'Resource budget'): void {
  for (const field of RESOURCE_BUDGET_FIELDS) {
    const value = budget[field];
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${label} ${field} must be finite and non-negative.`);
  }
}

export function addResourceBudgets(left: ResourceBudget, right: ResourceBudget): ResourceBudget {
  return Object.fromEntries(
    RESOURCE_BUDGET_FIELDS.map((field) => [field, left[field] + right[field]])
  ) as unknown as ResourceBudget;
}

export function resourceBudgetFits(
  used: ResourceBudget,
  estimate: ResourceBudget,
  limit: ResourceBudget
): boolean {
  return RESOURCE_BUDGET_FIELDS.every((field) => used[field] + estimate[field] <= limit[field]);
}

export function snapshotResourceBudget(budget: ResourceBudget): ResourceBudget {
  validateResourceBudget(budget);
  return { ...budget };
}
