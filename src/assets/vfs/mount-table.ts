import { normalizeVFSUri, parseCanonicalVFSUri, toNormalizedMountPath } from './uri';
import type {
  CanonicalVFSUri,
  ResolvedVFSMount,
  VFSMount,
  VFSProvider,
  VFSReadPolicy
} from './types';

interface RegisteredMount {
  readonly mount: VFSMount;
  readonly segments: readonly string[];
}

/** Registers validated VFS mounts and resolves the most-specific segment-aligned root. */
export class VFSMountTable {
  readonly #mounts = new Map<CanonicalVFSUri, RegisteredMount>();

  /** Retains an owned immutable mount snapshot. */
  register(mount: VFSMount): void {
    const root = normalizeVFSUri(mount.root);
    if (root !== mount.root) throw new Error('VFS mount root must be canonical.');
    if (this.#mounts.has(root)) throw new Error(`VFS mount is already registered: ${root}`);

    const parsedRoot = parseCanonicalVFSUri(root);
    if (parsedRoot.scheme !== mount.scheme) {
      throw new Error('VFS mount scheme must match its canonical root.');
    }
    validateProviderSet(mount);
    const policy = copyPolicy(mount.policy);
    const ownedMount: VFSMount = Object.freeze({
      scheme: parsedRoot.scheme,
      root,
      primary: mount.primary,
      caches: Object.freeze([...mount.caches]),
      ...(mount.fallback === undefined ? {} : { fallback: mount.fallback }),
      policy
    });
    this.#mounts.set(root, Object.freeze({ mount: ownedMount, segments: parsedRoot.segments }));
  }

  /** Resolves a canonical URI to the longest matching mount root. */
  resolve(uri: CanonicalVFSUri): ResolvedVFSMount {
    const parsedUri = parseCanonicalVFSUri(uri);
    let selected: RegisteredMount | undefined;
    for (const candidate of this.#mounts.values()) {
      if (candidate.mount.scheme !== parsedUri.scheme) continue;
      if (!isSegmentPrefix(candidate.segments, parsedUri.segments)) continue;
      if (!selected || candidate.segments.length > selected.segments.length) selected = candidate;
    }
    if (!selected) throw new Error(`No VFS mount matches: ${uri}`);

    return Object.freeze({
      mount: selected.mount,
      path: toNormalizedMountPath(parsedUri.segments.slice(selected.segments.length))
    });
  }
}

function isSegmentPrefix(root: readonly string[], path: readonly string[]): boolean {
  return root.length <= path.length && root.every((segment, index) => segment === path[index]);
}

function validateProviderSet(mount: VFSMount): void {
  const providers: VFSProvider[] = [
    mount.primary,
    ...mount.caches,
    ...(mount.fallback === undefined ? [] : [mount.fallback])
  ];
  const identities = new Set<string>();
  for (const provider of providers) {
    if (!provider.id) throw new Error('VFS provider id must be a non-empty string.');
    if (provider.capabilities.read !== true) throw new Error('VFS provider must support reads.');
    if (identities.has(provider.id)) {
      throw new Error(`VFS provider is duplicated within mount: ${provider.id}`);
    }
    identities.add(provider.id);
  }
}

function copyPolicy(policy: VFSReadPolicy): VFSReadPolicy {
  for (const failure of policy.fallbackOn as readonly string[]) {
    if (failure !== 'not-found' && failure !== 'offline') {
      throw new Error(`VFS fallback policy does not allow: ${failure}`);
    }
  }
  return Object.freeze({
    consultCaches: policy.consultCaches,
    fallbackOn: Object.freeze([...policy.fallbackOn])
  });
}
