import { pluginVersionId } from './ids';
import type {
  DynamicCapabilityDescriptor,
  DynamicCapabilityPlan,
  DynamicCapabilityRequest,
  DynamicPluginHostKind,
  DynamicPluginManifest,
  DynamicPluginPolicy,
  DynamicPluginVersionVerifier,
  PluginVersionId
} from './types';

const SUPPORTED_MANIFEST_SCHEMA_VERSION = 1;
const CRYPTOGRAPHIC_HASH_PATTERN = /^[a-z0-9_-]+:[a-f0-9]{8,128}$/i;

export function validateDynamicPluginManifest(
  manifest: DynamicPluginManifest,
  verifier: DynamicPluginVersionVerifier
): DynamicPluginManifest {
  if (manifest.schemaVersion !== SUPPORTED_MANIFEST_SCHEMA_VERSION) {
    throw new Error(`Unsupported dynamic plugin manifest schema ${manifest.schemaVersion}.`);
  }
  if (manifest.hosts.length === 0) {
    throw new Error('Dynamic plugin manifest must declare at least one host.');
  }

  assertUniqueHosts(manifest);
  assertValidCapabilities(manifest);
  assertValidArtifactHashes(manifest);
  if (!verifier.verify(manifest)) {
    throw new Error('Dynamic plugin version verification failed.');
  }

  return manifest;
}

export function computeCanonicalPluginVersionId(
  manifest: Omit<DynamicPluginManifest, 'versionId'> | DynamicPluginManifest
): PluginVersionId {
  const canonicalData = {
    schemaVersion: manifest.schemaVersion,
    pluginId: manifest.pluginId,
    hosts: [...manifest.hosts].sort((a, b) => a.kind.localeCompare(b.kind)),
    capabilities: [...manifest.capabilities].sort((a, b) => {
      const cmp = a.id.localeCompare(b.id);
      return cmp !== 0 ? cmp : a.version - b.version;
    }),
    artifactHashes: Object.keys(manifest.artifactHashes ?? {})
      .sort()
      .reduce<Record<string, string>>((acc, key) => {
        acc[key] = manifest.artifactHashes[key]!;
        return acc;
      }, {})
  };

  const serialized = canonicalStringify(canonicalData);
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < serialized.length; index++) {
    hash ^= BigInt(serialized.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return pluginVersionId(`sha256:${hash.toString(16).padStart(16, '0')}`);
}

export function createCanonicalVersionVerifier(): DynamicPluginVersionVerifier {
  return Object.freeze({
    verify(manifest: DynamicPluginManifest): boolean {
      const canonical = computeCanonicalPluginVersionId(manifest);
      return manifest.versionId === canonical;
    }
  });
}

export function planCapabilityAuthorization(
  manifest: DynamicPluginManifest,
  hostKind: DynamicPluginHostKind,
  supported: readonly DynamicCapabilityDescriptor[],
  policy: DynamicPluginPolicy
): DynamicCapabilityPlan {
  const host = manifest.hosts.find((request) => request.kind === hostKind);
  if (!host) {
    throw new Error(`Dynamic plugin manifest does not declare host ${hostKind}.`);
  }

  const granted: DynamicCapabilityRequest[] = [];
  const deniedOptional: DynamicCapabilityRequest[] = [];
  for (const request of manifest.capabilities) {
    const available = supported.some(
      (descriptor) =>
        descriptor.id === request.id &&
        descriptor.version === request.version &&
        descriptor.hostKinds.includes(hostKind)
    );
    const authorized = available && policy.authorize(request, hostKind) === 'granted';
    if (authorized) {
      granted.push(request);
    } else if (request.required) {
      throw new Error(
        `Required capability ${request.id}@${request.version} is unavailable or denied.`
      );
    } else {
      deniedOptional.push(request);
    }
  }

  return Object.freeze({
    granted: Object.freeze(granted),
    deniedOptional: Object.freeze(deniedOptional)
  });
}

function assertUniqueHosts(manifest: DynamicPluginManifest): void {
  const seen = new Set<DynamicPluginHostKind>();
  for (const host of manifest.hosts) {
    if (seen.has(host.kind)) {
      throw new Error(`Duplicate host ${host.kind} in dynamic plugin manifest.`);
    }
    seen.add(host.kind);
  }
}

function assertValidCapabilities(manifest: DynamicPluginManifest): void {
  const seen = new Set<string>();
  for (const capability of manifest.capabilities) {
    if (capability.id.trim().length === 0) {
      throw new Error('Dynamic capability ID must not be empty.');
    }
    if (!Number.isInteger(capability.version) || capability.version <= 0) {
      throw new Error(`Dynamic capability ${capability.id} must use a positive version.`);
    }
    const key = `${capability.id}\u0000${capability.version}`;
    if (seen.has(key)) {
      throw new Error(
        `Duplicate capability ${capability.id}@${capability.version} in dynamic plugin manifest.`
      );
    }
    seen.add(key);
  }
}

function assertValidArtifactHashes(manifest: DynamicPluginManifest): void {
  if (typeof manifest.artifactHashes !== 'object' || manifest.artifactHashes === null) {
    throw new Error('Dynamic plugin manifest artifact hashes must be an object.');
  }
  const entries = Object.entries(manifest.artifactHashes);
  for (const [file, hash] of entries) {
    if (typeof file !== 'string' || file.trim().length === 0) {
      throw new Error('Dynamic plugin artifact hash filename must not be empty.');
    }
    if (typeof hash !== 'string' || !CRYPTOGRAPHIC_HASH_PATTERN.test(hash.trim())) {
      throw new Error(
        `Dynamic plugin artifact hash for "${file}" must be a valid cryptographic hash format (e.g. sha256:<hex>).`
      );
    }
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(',')}}`;
}
