import { describe, expect, test } from 'vitest';
import {
  DEFAULT_VFS_READ_POLICY,
  normalizeVFSUri,
  parseCanonicalVFSUri,
  VFSMountTable
} from '../../../src/assets/vfs';
import type {
  CanonicalVFSUri,
  VFSMount,
  VFSProvider,
  VFSProviderId
} from '../../../src/assets/vfs';

describe('VFSMountTable', () => {
  test('selects the longest root at a complete path-segment boundary', () => {
    const table = new VFSMountTable();
    const rootProvider = provider('root');
    const textureProvider = provider('textures');
    table.register(mount('asset://', rootProvider));
    table.register(mount('asset://textures', textureProvider));

    expect(table.resolve(normalizeVFSUri('asset://textures/ui/button.png'))).toMatchObject({
      path: '/ui/button.png',
      mount: { root: 'asset://textures', primary: textureProvider }
    });
    expect(table.resolve(normalizeVFSUri('asset://texture/file.png'))).toMatchObject({
      path: '/texture/file.png',
      mount: { root: 'asset://', primary: rootProvider }
    });
  });

  test('rejects duplicate mount roots and unmatched schemes', () => {
    const table = new VFSMountTable();
    const rootProvider = provider('root');
    table.register(mount('asset://textures', rootProvider));

    expect(() => table.register(mount('asset://textures', rootProvider))).toThrow(
      'VFS mount is already registered: asset://textures'
    );
    expect(() => table.resolve(normalizeVFSUri('package://main.chunk'))).toThrow(
      'No VFS mount matches: package://main.chunk'
    );
  });

  test('copies caller-owned cache and policy arrays when registering', () => {
    const table = new VFSMountTable();
    const caches = [provider('cache')];
    const fallbackOn: ('not-found' | 'offline')[] = ['not-found'];
    const registration = mount('asset://', provider('root'), caches, fallbackOn);
    table.register(registration);
    caches.push(provider('late-cache'));
    fallbackOn.push('offline');

    const resolved = table.resolve(normalizeVFSUri('asset://file.bin'));
    expect(resolved.mount.caches.map(({ id }) => id)).toEqual(['cache']);
    expect(resolved.mount.policy.fallbackOn).toEqual(['not-found']);
    expect(Object.isFrozen(resolved.mount.caches)).toBe(true);
    expect(Object.isFrozen(resolved.mount.policy.fallbackOn)).toBe(true);
  });
});

function provider(id: string): VFSProvider {
  return {
    id: id as VFSProviderId,
    capabilities: { read: true, range: false, write: false, watch: false },
    read: async () => {
      throw new Error('Mount table tests do not perform provider reads.');
    }
  };
}

function mount(
  rootInput: string,
  primary: VFSProvider,
  caches: VFSProvider[] = [],
  fallbackOn: ('not-found' | 'offline')[] = [...DEFAULT_VFS_READ_POLICY.fallbackOn]
): VFSMount {
  const root = normalizeVFSUri(rootInput);
  return {
    scheme: parseCanonicalVFSUri(root).scheme,
    root: root as CanonicalVFSUri,
    primary,
    caches,
    policy: { consultCaches: true, fallbackOn }
  };
}
