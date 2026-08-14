import { describe, expect, it } from 'vitest';
import {
  computeCanonicalPluginVersionId,
  createCanonicalVersionVerifier,
  dynamicPluginId,
  planCapabilityAuthorization,
  pluginVersionId,
  validateDynamicPluginManifest,
  type DynamicCapabilityRequest,
  type DynamicPluginHostRequest,
  type DynamicPluginManifest,
  type DynamicPluginPolicy,
  type DynamicPluginVersionVerifier
} from '../../src/dynamic-plugins';

const acceptingVerifier: DynamicPluginVersionVerifier = {
  verify: () => true
};

const denyAllPolicy: DynamicPluginPolicy = {
  authorize: () => 'denied'
};

describe('dynamic plugin manifest contracts', () => {
  it('rejects empty branded identities', () => {
    expect(() => dynamicPluginId('  ')).toThrow(/plugin id/i);
    expect(() => pluginVersionId('')).toThrow(/version id/i);
  });

  it('rejects duplicate hosts before activation', () => {
    const manifest = manifestWith({
      hosts: [
        { kind: 'editor', required: true },
        { kind: 'editor', required: false }
      ]
    });

    expect(() => validateDynamicPluginManifest(manifest, acceptingVerifier)).toThrow(
      /duplicate host.*editor/i
    );
  });

  it('rejects duplicate capability requests before activation', () => {
    const capability = {
      id: 'editor.panel.contribute',
      version: 1,
      required: true
    } as const;
    const manifest = manifestWith({ capabilities: [capability, capability] });

    expect(() => validateDynamicPluginManifest(manifest, acceptingVerifier)).toThrow(
      /duplicate capability.*editor\.panel\.contribute/i
    );
  });

  it('fails a required denial and records an optional denial', () => {
    const required = capabilityRequest('editor.panel.contribute', true);
    expect(() =>
      planCapabilityAuthorization(
        manifestWith({ capabilities: [required] }),
        'editor',
        [],
        denyAllPolicy
      )
    ).toThrow(/required capability/i);

    const optional = capabilityRequest('editor.panel.contribute', false);
    const plan = planCapabilityAuthorization(
      manifestWith({ capabilities: [optional] }),
      'editor',
      [],
      denyAllPolicy
    );
    expect(plan.granted).toEqual([]);
    expect(plan.deniedOptional).toEqual([optional]);
    expect(Object.isFrozen(plan.deniedOptional)).toBe(true);
  });

  it('rejects missing or invalid artifact hashes', () => {
    expect(() =>
      validateDynamicPluginManifest(
        manifestWith({ artifactHashes: null as unknown as Record<string, string> }),
        acceptingVerifier
      )
    ).toThrow(/artifact hash/i);

    expect(() =>
      validateDynamicPluginManifest(
        manifestWith({ artifactHashes: { 'bundle.js': '' } }),
        acceptingVerifier
      )
    ).toThrow(/format/i);

    expect(() =>
      validateDynamicPluginManifest(
        manifestWith({ artifactHashes: { 'bundle.js': 'anything' } }),
        acceptingVerifier
      )
    ).toThrow(/format/i);

    expect(() =>
      validateDynamicPluginManifest(
        manifestWith({ artifactHashes: { 'bundle.js': 'unknown:0123456789abcdef' } }),
        acceptingVerifier
      )
    ).toThrow(/unsupported algorithm/i);

    expect(() =>
      validateDynamicPluginManifest(
        manifestWith({ artifactHashes: { 'bundle.js': 'sha256:deadbeef' } }),
        acceptingVerifier
      )
    ).toThrow(/exactly 64 hex characters/i);
  });

  it('computes canonical version id with real sha256 and verifies matching manifest', () => {
    const manifest = manifestWith({
      versionId: pluginVersionId('sha256:will-be-replaced')
    });
    const canonicalId = computeCanonicalPluginVersionId(manifest);
    expect(canonicalId).toMatch(/^sha256:[a-f0-9]{64}$/);

    const validManifest = manifestWith({ versionId: canonicalId });
    const verifier = createCanonicalVersionVerifier();
    expect(validateDynamicPluginManifest(validManifest, verifier)).toBe(validManifest);

    const tamperedManifest = manifestWith({
      versionId: canonicalId,
      artifactHashes: Object.freeze({
        'bundle.js': 'sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff'
      })
    });
    expect(() => validateDynamicPluginManifest(tamperedManifest, verifier)).toThrow(
      /version verification failed/i
    );
  });
});

function capabilityRequest(id: string, required: boolean): DynamicCapabilityRequest {
  return Object.freeze({ id, version: 1, required });
}

function manifestWith(overrides: Partial<DynamicPluginManifest> = {}): DynamicPluginManifest {
  return Object.freeze({
    schemaVersion: 1,
    pluginId: dynamicPluginId('com.example.panel'),
    versionId: pluginVersionId('sha256:version-1'),
    hosts: Object.freeze([{ kind: 'editor', required: true }] satisfies DynamicPluginHostRequest[]),
    capabilities: Object.freeze([]),
    artifactHashes: Object.freeze({
      'bundle.js': 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
    }),
    ...overrides
  });
}
