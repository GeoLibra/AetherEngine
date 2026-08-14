import { pluginVersionId } from './ids';
import { computeSha256Hex } from './sha256';
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

const SUPPORTED_HASH_ALGORITHMS: Readonly<Record<string, number>> = Object.freeze({
  sha256: 64,
  sha384: 96,
  sha512: 128
});
const HEX_CHARS_PATTERN = /^[a-f0-9]+$/i;

function codePointCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

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
    hosts: [...manifest.hosts].sort((a, b) => codePointCompare(a.kind, b.kind)),
    capabilities: [...manifest.capabilities].sort((a, b) => {
      const cmp = codePointCompare(a.id, b.id);
      return cmp !== 0 ? cmp : a.version - b.version;
    }),
    artifactHashes: Object.keys(manifest.artifactHashes ?? {})
      .sort(codePointCompare)
      .reduce<Record<string, string>>((acc, key) => {
        acc[key] = manifest.artifactHashes[key]!;
        return acc;
      }, {})
  };

  const serialized = canonicalStringify(canonicalData);
  const hex = computeSha256Hex(serialized);
  return pluginVersionId(`sha256:${hex}`);
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
    if (typeof hash !== 'string') {
      throw new Error(`Dynamic plugin artifact hash for "${file}" must be a string.`);
    }
    const colon = hash.indexOf(':');
    if (colon <= 0) {
      throw new Error(
        `Dynamic plugin artifact hash for "${file}" must follow the "<algorithm>:<digest>" format.`
      );
    }
    const algorithm = hash.slice(0, colon).toLowerCase();
    const digest = hash.slice(colon + 1);
    const expectedLength = SUPPORTED_HASH_ALGORITHMS[algorithm];
    if (expectedLength === undefined) {
      throw new Error(
        `Dynamic plugin artifact hash for "${file}" uses unsupported algorithm "${algorithm}". Supported algorithms are sha256, sha384, sha512.`
      );
    }
    if (digest.length !== expectedLength || !HEX_CHARS_PATTERN.test(digest)) {
      throw new Error(
        `Dynamic plugin artifact hash for "${file}" must have exactly ${expectedLength} hex characters for ${algorithm}.`
      );
    }
  }
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort(codePointCompare)
    .map((key) => `${JSON.stringify(key)}:${canonicalStringify(record[key])}`)
    .join(',')}}`;
}
