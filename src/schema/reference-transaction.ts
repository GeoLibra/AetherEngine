import { cloneUnknown, freezeUnknown } from './utils';
import type { ReferenceResolutionIssue, ResolvedReferenceEntry } from './types';

/**
 * Error thrown when one or more required references cannot be resolved during a reference transaction.
 */
export class ReferenceResolutionError extends Error {
  readonly code = 'schema/reference-resolution-failed';

  constructor(readonly issues: readonly ReferenceResolutionIssue[]) {
    super(
      `Reference transaction failed with ${issues.length} unresolved required reference${
        issues.length === 1 ? '' : 's'
      }.`
    );
  }
}

/**
 * Deeply clones and freezes an array of resolved reference entries.
 *
 * @param entries - The resolved reference entries to freeze.
 * @returns An immutable, frozen list of entries.
 */
export function freezeResolvedEntries(
  entries: readonly ResolvedReferenceEntry[]
): readonly ResolvedReferenceEntry[] {
  return freezeUnknown(cloneUnknown(entries)) as readonly ResolvedReferenceEntry[];
}
