import type { FeatureId, HostServiceId, ImplementationId } from './types';

export function featureId(value: string): FeatureId {
  return validatedId(value, 'Feature ID') as FeatureId;
}

export function implementationId(value: string): ImplementationId {
  return validatedId(value, 'Implementation ID') as ImplementationId;
}

export function hostServiceId(value: string): HostServiceId {
  return validatedId(value, 'Host service ID') as HostServiceId;
}

function validatedId(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} must not be empty.`);
  return normalized;
}
