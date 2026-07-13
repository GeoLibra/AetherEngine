import { cloneUnknown, freezeUnknown } from './migration';
import type {
  ReferenceResolutionIssue,
  ResolvedReferenceEntry
} from './types';

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

export function freezeResolvedEntries(
  entries: readonly ResolvedReferenceEntry[]
): readonly ResolvedReferenceEntry[] {
  return freezeUnknown(cloneUnknown(entries)) as readonly ResolvedReferenceEntry[];
}
