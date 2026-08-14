import type {
  DynamicCapabilityDescriptor,
  DynamicCapabilityPlan,
  DynamicCapabilityRequest,
  DynamicPluginHostKind,
  DynamicPluginManifest,
  DynamicPluginPolicy,
  DynamicPluginVersionVerifier
} from './types';

const SUPPORTED_MANIFEST_SCHEMA_VERSION = 1;

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
  if (!verifier.verify(manifest)) {
    throw new Error('Dynamic plugin version verification failed.');
  }

  return manifest;
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
