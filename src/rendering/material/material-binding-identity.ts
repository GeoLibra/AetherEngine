import type { CanonicalKey } from '../pipeline/types';
import { createCanonicalKey } from '../pipeline/pipeline-resolver';
import type { CompiledMaterialBinding } from './material-bindings';

export type MaterialBindingLayoutIdentityEntry = Readonly<
  | {
      readonly kind: 'texture';
      readonly group: number;
      readonly binding: number;
      readonly bindingPath: string;
      readonly viewDimension: '2d' | 'cube';
      readonly sampleType: 'float' | 'depth' | 'uint' | 'sint';
      readonly multisampled: boolean;
    }
  | {
      readonly kind: 'sampler';
      readonly group: number;
      readonly binding: number;
      readonly bindingPath: string;
      readonly samplerType: 'filtering' | 'non-filtering' | 'comparison';
    }
>;

/** Value-only facts that define one CPU Material binding layout identity. */
export interface MaterialBindingLayoutIdentityParts {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly schemaFingerprint: string;
  readonly shaderLayoutHash: string;
  readonly entries: readonly MaterialBindingLayoutIdentityEntry[];
}

/** Creates a canonical identity independent of reflection and schema insertion order. */
export function createMaterialBindingLayoutIdentity(input: {
  readonly schemaId: string;
  readonly schemaVersion: number;
  readonly schemaFingerprint: string;
  readonly shaderLayoutHash: string;
  readonly entries: readonly CompiledMaterialBinding[];
}): CanonicalKey<MaterialBindingLayoutIdentityParts> {
  const entries = input.entries.map(identityEntry).sort(compareEntries);
  return createCanonicalKey(
    Object.freeze({
      schemaId: input.schemaId,
      schemaVersion: input.schemaVersion,
      schemaFingerprint: input.schemaFingerprint,
      shaderLayoutHash: input.shaderLayoutHash,
      entries: Object.freeze(entries)
    })
  );
}

function identityEntry(entry: CompiledMaterialBinding): MaterialBindingLayoutIdentityEntry {
  const base = {
    kind: entry.kind,
    group: entry.group,
    binding: entry.binding,
    bindingPath: entry.bindingPath
  };
  return Object.freeze(
    entry.kind === 'texture'
      ? {
          ...base,
          kind: 'texture' as const,
          viewDimension: entry.viewDimension,
          sampleType: entry.sampleType,
          multisampled: entry.multisampled
        }
      : { ...base, kind: 'sampler' as const, samplerType: entry.samplerType }
  );
}

function compareEntries(
  left: MaterialBindingLayoutIdentityEntry,
  right: MaterialBindingLayoutIdentityEntry
): number {
  return (
    left.group - right.group ||
    left.binding - right.binding ||
    (left.bindingPath < right.bindingPath ? -1 : left.bindingPath > right.bindingPath ? 1 : 0)
  );
}
