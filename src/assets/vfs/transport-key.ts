/** @file Pure transport key derivation for in-flight coalescing and cache partitioning. */

import type { ByteRange, VFSTransportKey } from './types';

export interface VFSTransportKeyParams {
  readonly providerId: string;
  readonly canonicalUri: string;
  readonly channel: string;
  readonly revision?: string;
  readonly range?: ByteRange;
  readonly credentialPartition?: string;
  readonly integrity?: string;
  readonly transportUrl?: string;
}

/**
 * Derives a deterministic transport key for in-flight request deduplication and cache partitioning.
 *
 * Distinct combinations of provider, URI, delivery channel, range slice, representation revision,
 * and credential partition yield distinct keys.
 */
export function deriveVFSTransportKey(params: VFSTransportKeyParams): VFSTransportKey {
  const parts: string[] = [
    `provider:${params.providerId}`,
    `uri:${params.canonicalUri}`,
    `channel:${params.channel}`
  ];

  if (params.revision !== undefined) {
    parts.push(`rev:${params.revision}`);
  }

  if (params.range !== undefined) {
    parts.push(`range:${params.range.offset}+${params.range.length}`);
  } else {
    parts.push('range:full');
  }

  if (params.credentialPartition !== undefined) {
    parts.push(`partition:${params.credentialPartition}`);
  } else {
    parts.push('partition:default');
  }

  if (params.integrity !== undefined) {
    parts.push(`integrity:${params.integrity}`);
  }

  if (params.transportUrl !== undefined && params.revision === undefined) {
    // For mutable unversioned endpoints, include the sanitized URL
    parts.push(`url:${params.transportUrl}`);
  }

  return parts.join('|') as VFSTransportKey;
}
