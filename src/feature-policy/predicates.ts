import type { CapabilityPredicate, CapabilityPredicateInput, PredicateResult } from './types';

export function evaluateCapabilityPredicate(
  predicate: CapabilityPredicate,
  input: CapabilityPredicateInput
): PredicateResult {
  let actual: unknown;
  let satisfied: boolean;
  switch (predicate.kind) {
    case 'feature': {
      actual = input.capabilities.features.get(predicate.feature)?.status ?? 'unsupported';
      satisfied = predicate.statuses.includes(actual as never);
      break;
    }
    case 'limit': {
      actual = input.capabilities.limits[predicate.limit];
      satisfied = typeof actual === 'number' && actual >= predicate.minimum;
      break;
    }
    case 'format': {
      actual = input.capabilities.formats.get(predicate.format)?.[predicate.capability] ?? false;
      satisfied = actual === true;
      break;
    }
    case 'queue': {
      actual =
        input.capabilities.queues.find(({ role }) => role === predicate.role)?.status ??
        'unsupported';
      satisfied = predicate.statuses.includes(actual as never);
      break;
    }
    case 'service': {
      actual = input.hostServices.has(predicate.service);
      satisfied = actual === true;
      break;
    }
  }
  return Object.freeze({
    predicate: snapshotPredicate(predicate),
    satisfied,
    actual,
    reason: satisfied
      ? 'Capability predicate satisfied.'
      : `Capability predicate ${predicate.kind} was not satisfied.`
  });
}

export function snapshotPredicate(predicate: CapabilityPredicate): CapabilityPredicate {
  return Object.freeze({
    ...predicate,
    ...('statuses' in predicate ? { statuses: Object.freeze([...predicate.statuses]) } : {})
  }) as CapabilityPredicate;
}
